import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

interface CliArgs {
  service: string;
  language: string;
  framework?: string;
  useCase: string;
  existingPatterns?: string;
  out: string;
  server: string;
  key: string;
  version: string;
  includeTests: boolean;
  endpoints: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      values.set(key, "true");
      continue;
    }
    values.set(key, next);
    index += 1;
  }

  const service = values.get("service");
  const language = values.get("language");
  const useCase = values.get("use-case");
  const out = values.get("out");
  const server = values.get("server");
  const key = values.get("key");

  if (!service || !language || !useCase || !out || !server || !key) {
    throw new Error("Missing required args. Required: --service --language --use-case --out --server --key");
  }

  return {
    service,
    language,
    framework: values.get("framework") ?? undefined,
    useCase,
    existingPatterns: values.get("existing-patterns") ?? undefined,
    out,
    server: server.replace(/\/+$/, ""),
    key,
    version: values.get("version") ?? "latest",
    includeTests: values.get("include-tests") !== "false",
    endpoints: (values.get("endpoints") ?? "")
      .split(",")
      .map((endpoint) => endpoint.trim())
      .filter(Boolean),
  };
}

async function postGenerate(args: CliArgs): Promise<Response> {
  return fetch(`${args.server}/generate?api_key=${encodeURIComponent(args.key)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      service_id: args.service,
      version: args.version,
      consumer_context: {
        language: args.language,
        framework: args.framework,
        use_case: args.useCase,
        existing_patterns: args.existingPatterns,
      },
      options: {
        include_tests: args.includeTests,
        endpoints: args.endpoints,
      },
    }),
  });
}

async function pollUntilComplete(server: string, key: string, pollPath: string): Promise<Record<string, unknown>> {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const response = await fetch(`${server}${pollPath}?api_key=${encodeURIComponent(key)}`);
    if (!response.ok) {
      throw new Error(`Polling failed with status ${response.status}`);
    }
    const payload = await response.json() as {
      status: string;
      result?: Record<string, unknown>;
      error?: string | null;
    };

    if (payload.status === "complete") {
      return payload.result ?? {};
    }
    if (payload.status === "failed") {
      throw new Error(payload.error ?? "Generate job failed");
    }
  }
}

function formatBytes(content: string): string {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

async function writeFiles(outDir: string, files: Array<{ filename: string; content: string }>): Promise<void> {
  await mkdir(outDir, { recursive: true });
  for (const file of files) {
    const target = join(outDir, file.filename);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const response = await postGenerate(args);
  if (!response.ok && response.status !== 202) {
    throw new Error(`Generate request failed with status ${response.status}`);
  }

  let result: Record<string, unknown>;
  if (response.status === 202) {
    const payload = await response.json() as { poll: string };
    result = await pollUntilComplete(args.server, args.key, payload.poll);
  } else {
    result = await response.json() as Record<string, unknown>;
  }

  const files = (result.files ?? []) as Array<{ filename: string; content: string; source?: string }>;
  await writeFiles(args.out, files);

  const summaryLines = [
    `BridgeFill - Generated ${files.length} files`,
    `Schema version : ${String(result.schema_version ?? "unknown")}`,
    `Model used     : ${String(result.model_used ?? "fallback")}`,
    `Duration       : ${Number(result.generation_time_ms ?? 0).toLocaleString()}ms`,
    "",
  ];

  for (const file of files) {
    summaryLines.push(`  ${file.filename.padEnd(28)} ${(file.source ?? "generated").toUpperCase().padEnd(16)} ${formatBytes(file.content)}`);
  }

  process.stdout.write(`${summaryLines.join("\n")}\n`);
}

void main().catch((error: Error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
