import { config } from "../../config/index.js";
import { callLLM } from "./llm-client.js";
function extensionForLanguage(language) {
    switch ((language ?? "javascript").toLowerCase()) {
        case "typescript":
            return "ts";
        case "python":
            return "py";
        case "go":
            return "go";
        default:
            return "js";
    }
}
function sanitizeEndpointFilename(endpoint) {
    const pathPart = endpoint.path
        .replace(/^\/+/, "")
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return `${endpoint.method.toLowerCase()}_${pathPart || "root"}`;
}
function filterEndpoints(contract, consumerContext) {
    const needed = consumerContext.endpoints_needed ?? [];
    if (!needed.length) {
        return contract.endpoints;
    }
    return contract.endpoints.filter((endpoint) => needed.includes(endpoint.path));
}
function stripMarkdownFences(input) {
    const trimmed = input.trim();
    if (trimmed.startsWith("```")) {
        return trimmed.replace(/^```[a-zA-Z0-9]*\n?/, "").replace(/\n?```$/, "").trim();
    }
    return trimmed;
}
function parseLlmJson(input) {
    const stripped = stripMarkdownFences(input);
    try {
        return JSON.parse(stripped);
    }
    catch {
        const match = stripped.match(/\{[\s\S]*\}/);
        if (!match) {
            throw new Error("LLM response did not contain parseable JSON");
        }
        return JSON.parse(match[0]);
    }
}
function buildSystemPrompt() {
    return [
        "You are a senior integration engineer at BridgeFill, a B2B middleware platform.",
        "Your job is to generate production-quality integration code that lets a consumer application call a provider's API correctly and safely.",
        "",
        "CRITICAL OUTPUT FORMAT:",
        "Respond with ONLY a valid JSON object - no markdown, no explanation, no preamble.",
        "The JSON must have this exact structure:",
        "{",
        '  "files": [{ "filename": "...", "description": "...", "content": "..." }],',
        '  "summary": "2-3 sentence summary",',
        '  "nextSteps": ["step 1"],',
        '  "warnings": ["any caveats"]',
        "}",
    ].join("\n");
}
function buildUserMessage({ contract, codeSamples, consumerContext, negotiation, }) {
    const endpoints = filterEndpoints(contract, consumerContext);
    const sections = [
        "## Consumer stack context",
        JSON.stringify(consumerContext, null, 2),
        "",
        "## Provider API contract",
        JSON.stringify({ ...contract, endpoints }, null, 2),
        "",
        "## Provider-supplied authoritative code samples",
        "The following samples come directly from the provider's engineering team.",
        "Treat them as ground truth - adapt for the consumer's stack but stay consistent with the patterns shown.",
        JSON.stringify(codeSamples, null, 2),
        "",
        "## Conflict and negotiation result",
        JSON.stringify({
            canProceed: negotiation.canProceed,
            usableEndpoints: negotiation.usableEndpoints,
            blockedEndpoints: negotiation.blockedEndpoints,
            recommendation: negotiation.conflicts.recommendation,
        }, null, 2),
    ];
    if (negotiation.blockedEndpoints.length > 0) {
        sections.push("", "DO NOT generate code for these endpoints:", JSON.stringify(negotiation.blockedEndpoints, null, 2));
    }
    return sections.join("\n");
}
function buildAuthFile(contract, ext) {
    if (contract.auth.type === "api_key") {
        const keyName = (contract.auth.key_name ?? "API_KEY").replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
        const locationLine = contract.auth.location === "query"
            ? `params: { ${contract.auth.key_name ?? "api_key"}: API_KEY },`
            : `headers: { "${contract.auth.key_name ?? "X-API-Key"}": API_KEY },`;
        return {
            filename: `auth_setup.${ext}`,
            description: "HTTP client auth configuration",
            source: "fallback_generated",
            content: ext === "ts"
                ? [
                    "import axios from 'axios';",
                    "",
                    `const API_KEY = process.env.${keyName} ?? '';`,
                    "if (!API_KEY) console.warn('[bridgefill] Missing API key - requests will fail');",
                    "",
                    "export const apiClient = axios.create({",
                    `  baseURL: '${contract.base_url}',`,
                    `  ${locationLine}`,
                    "  timeout: 10_000,",
                    "});",
                    "",
                ].join("\n")
                : [
                    `const API_KEY = process.env.${keyName} ?? '';`,
                    "if (!API_KEY) console.warn('[bridgefill] Missing API key - requests will fail');",
                    "",
                    "export const apiClient = {",
                    `  baseURL: '${contract.base_url}',`,
                    `  ${locationLine}`,
                    "  timeout: 10_000,",
                    "};",
                ].join("\n"),
        };
    }
    return {
        filename: `auth_setup.${ext}`,
        description: "HTTP client auth configuration",
        source: "fallback_generated",
        content: [
            `export const baseUrl = '${contract.base_url}';`,
            `export const authType = '${contract.auth.type}';`,
            "",
        ].join("\n"),
    };
}
function selectProviderSample(codeSamples, endpoint, language) {
    const byLanguage = codeSamples.find((sample) => sample.language?.toLowerCase() === (language ?? "").toLowerCase() && sample.content);
    if (byLanguage) {
        return byLanguage;
    }
    const byEndpointMention = codeSamples.find((sample) => sample.content?.includes(endpoint.path));
    return byEndpointMention ?? codeSamples.find((sample) => !!sample.content) ?? null;
}
function buildEndpointFile(endpoint, ext, consumerContext, providerSample) {
    if (providerSample?.content) {
        return {
            filename: `${sanitizeEndpointFilename(endpoint)}.${ext}`,
            description: `Authoritative provider sample for ${endpoint.method} ${endpoint.path}`,
            content: providerSample.content,
            source: "provider_sample",
        };
    }
    const paramList = endpoint.all_params.map((param) => `${param.name}${param.required ? "" : "?"}`).join(", ");
    const requiredMentions = endpoint.required_params.map((param) => `// required: ${param.name}`).join("\n");
    if (ext === "py") {
        return {
            filename: `${sanitizeEndpointFilename(endpoint)}.${ext}`,
            description: `Fallback stub for ${endpoint.method} ${endpoint.path}`,
            source: "fallback_generated",
            content: [
                `# ${endpoint.method} ${endpoint.path}`,
                requiredMentions.replaceAll("// ", "# "),
                `def ${sanitizeEndpointFilename(endpoint)}(params=None):`,
                "    params = params or {}",
                `    required_params = [${endpoint.required_params.map((param) => `"${param.name}"`).join(", ")}]`,
                "    for required_param in required_params:",
                "        if required_param not in params:",
                "            raise ValueError(f'Missing required param: {required_param}')",
                "    return {",
                `        "endpoint": "${endpoint.path}",`,
                `        "method": "${endpoint.method}",`,
                '        "params": params,',
                `        "expected_params": "${paramList}",`,
                "    }",
            ].join("\n"),
        };
    }
    const functionName = sanitizeEndpointFilename(endpoint);
    return {
        filename: `${functionName}.${ext}`,
        description: `Fallback stub for ${endpoint.method} ${endpoint.path}`,
        source: "fallback_generated",
        content: [
            `// ${endpoint.method} ${endpoint.path}`,
            requiredMentions,
            `export async function ${functionName}(params = {}) {`,
            `  const requiredParams = [${endpoint.required_params.map((param) => `"${param.name}"`).join(", ")}];`,
            "  for (const requiredParam of requiredParams) {",
            "    if (!(requiredParam in params)) {",
            "      throw new Error(`Missing required param: ${requiredParam}`);",
            "    }",
            "  }",
            "  return {",
            `    endpoint: "${endpoint.path}",`,
            `    method: "${endpoint.method}",`,
            `    params,`,
            `    expectedParams: "${paramList}",`,
            "  };",
            "}",
            "",
        ].filter(Boolean).join("\n"),
    };
}
function buildTestFile(ext, endpoints) {
    return {
        filename: `integration.test.${ext}`,
        description: "Basic integration verification stub",
        source: "fallback_generated",
        content: [
            "// Basic integration verification",
            `export const coveredEndpoints = ${JSON.stringify(endpoints.map((endpoint) => endpoint.path), null, 2)};`,
            "",
        ].join("\n"),
    };
}
function buildFallbackOutput({ contract, codeSamples, consumerContext, negotiation, }) {
    const ext = extensionForLanguage(consumerContext.language);
    const endpoints = filterEndpoints(contract, consumerContext).filter((endpoint) => !negotiation.blockedEndpoints.includes(endpoint.path));
    const files = [buildAuthFile(contract, ext)];
    for (const endpoint of endpoints) {
        files.push(buildEndpointFile(endpoint, ext, consumerContext, selectProviderSample(codeSamples, endpoint, consumerContext.language)));
    }
    files.push(buildTestFile(ext, endpoints));
    return {
        files,
        summary: `Generated ${files.length} integration file${files.length === 1 ? "" : "s"} using the deterministic fallback path.`,
        nextSteps: [
            "Review provider_sample files first - they are authoritative.",
            "Wire the generated functions into your application flow.",
            "Run validate_integration before shipping.",
        ],
        warnings: negotiation.blockedEndpoints.length
            ? [`Skipped blocked endpoints: ${negotiation.blockedEndpoints.join(", ")}`]
            : [],
        source: "fallback",
        model: null,
    };
}
export async function generateIntegrationCode({ contract, codeSamples, consumerContext, negotiation, }) {
    if (!config.llm.apiKey) {
        return buildFallbackOutput({ contract, codeSamples, consumerContext, negotiation });
    }
    try {
        const content = await callLLM({
            systemPrompt: buildSystemPrompt(),
            userMessage: buildUserMessage({ contract, codeSamples, consumerContext, negotiation }),
            maxTokens: 4096,
        });
        const parsed = parseLlmJson(content);
        return {
            files: parsed.files.map((file) => ({
                ...file,
                source: "llm_generated",
            })),
            summary: parsed.summary,
            nextSteps: parsed.nextSteps,
            warnings: parsed.warnings ?? [],
            source: "llm",
            model: config.llm.model,
        };
    }
    catch {
        return buildFallbackOutput({ contract, codeSamples, consumerContext, negotiation });
    }
}
