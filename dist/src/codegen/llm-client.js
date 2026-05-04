import { config } from "../../config/index.js";
let logged = false;
export class LLMError extends Error {
    constructor(message) {
        super(message);
        this.name = "LLMError";
    }
}
export async function callLLM({ systemPrompt, userMessage, maxTokens, }) {
    const { provider, model, baseUrl, apiKey, maxTokens: defaultMax } = config.llm;
    if (!apiKey) {
        throw new LLMError("LLM_API_KEY is not set");
    }
    if (!logged && config.app.env !== "test") {
        process.stderr.write(`[llm] provider=${provider} model=${model} baseUrl=${baseUrl}\n`);
        logged = true;
    }
    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            max_tokens: maxTokens ?? defaultMax,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage },
            ],
        }),
    });
    if (!response.ok) {
        const errText = await response.text().catch(() => "unknown error");
        throw new LLMError(`LLM API returned ${response.status}: ${errText}`);
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
        throw new LLMError("LLM response missing choices[0].message.content");
    }
    return content;
}
