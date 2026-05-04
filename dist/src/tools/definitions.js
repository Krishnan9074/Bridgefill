function createTool(name, description, inputSchema) {
    return { name, description, inputSchema };
}
const orgTokenProperty = {
    type: "string",
    description: "Scoped org JWT returned by /auth/token.",
};
const serviceIdProperty = {
    type: "string",
    description: "Service identifier returned by register_service.",
};
const sessionIdProperty = {
    type: "string",
    description: "Session identifier returned by join_session.",
};
const schemaContract = {
    type: "object",
    description: "Provider-published API contract.",
    required: ["base_url", "auth", "endpoints"],
    properties: {
        base_url: { type: "string", description: "Base URL for the provider API." },
        auth: {
            type: "object",
            required: ["type"],
            properties: {
                type: {
                    type: "string",
                    enum: ["api_key", "oauth2", "bearer", "basic", "none"],
                },
                location: {
                    type: "string",
                    enum: ["header", "query", "body"],
                },
                key_name: {
                    type: "string",
                    description: "Header/query/body field name for the credential.",
                },
            },
            additionalProperties: true,
        },
        endpoints: {
            type: "array",
            items: {
                type: "object",
                required: ["path", "method"],
                properties: {
                    path: { type: "string" },
                    method: {
                        type: "string",
                        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
                    },
                    summary: { type: "string" },
                    parameters: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                name: { type: "string" },
                                in: {
                                    type: "string",
                                    enum: ["query", "path", "header", "body"],
                                },
                                required: { type: "boolean" },
                                description: { type: "string" },
                                schema: { type: "object", additionalProperties: true },
                            },
                            additionalProperties: true,
                        },
                    },
                    response_schema: { type: "object", additionalProperties: true },
                },
                additionalProperties: true,
            },
        },
        rate_limits: {
            type: "object",
            properties: {
                requests_per_second: { type: "number" },
                requests_per_day: { type: "number" },
            },
            additionalProperties: true,
        },
        sdk_languages: {
            type: "array",
            items: { type: "string" },
        },
    },
    additionalProperties: true,
};
const consumerContext = {
    type: "object",
    description: "Consumer application context for targeted code generation.",
    required: ["language", "use_case"],
    properties: {
        language: {
            type: "string",
            description: "Target language, for example typescript, python, or go.",
        },
        framework: {
            type: "string",
            description: "Target framework, for example nextjs, fastapi, or gin.",
        },
        use_case: {
            type: "string",
            description: "Description of what the consumer wants to build.",
        },
        existing_patterns: {
            type: "string",
            description: "How the consumer codebase handles HTTP, auth, and errors.",
        },
        endpoints_needed: {
            type: "array",
            description: "Subset of endpoint paths to target. Empty means all endpoints.",
            items: { type: "string" },
        },
    },
    additionalProperties: true,
};
export const TOOL_DEFINITIONS = [
    createTool("ping", "Health check that returns server time and protocol version.", {
        type: "object",
        properties: {
            echo: {
                description: "Optional payload echoed back by the server.",
            },
        },
        additionalProperties: false,
    }),
    createTool("register_service", "Provider-only tool to declare an API service.", {
        type: "object",
        required: ["service_name", "service_description"],
        properties: {
            org_token: orgTokenProperty,
            service_name: { type: "string" },
            service_description: { type: "string" },
            service_version: { type: "string", default: "1.0.0" },
            tags: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
    }),
    createTool("join_session", "Create or join an integration session for a service.", {
        type: "object",
        required: ["service_id"],
        properties: {
            org_token: orgTokenProperty,
            service_id: serviceIdProperty,
            preferred_role: {
                type: "string",
                enum: ["provider", "consumer"],
            },
        },
        additionalProperties: false,
    }),
    createTool("get_session_status", "Poll session state, participants, and messages.", {
        type: "object",
        required: ["session_id"],
        properties: {
            org_token: orgTokenProperty,
            session_id: sessionIdProperty,
        },
        additionalProperties: false,
    }),
    createTool("publish_schema", "Publish an API schema fragment for a session.", {
        type: "object",
        required: ["session_id", "schema"],
        properties: {
            org_token: orgTokenProperty,
            session_id: sessionIdProperty,
            schema: schemaContract,
        },
        additionalProperties: false,
    }),
    createTool("provide_code_sample", "Attach provider-authored code samples to a session schema.", {
        type: "object",
        required: ["session_id", "sample"],
        properties: {
            org_token: orgTokenProperty,
            session_id: sessionIdProperty,
            sample: {
                type: "object",
                properties: {
                    language: { type: "string" },
                    description: { type: "string" },
                    content: { type: "string" },
                },
                additionalProperties: true,
            },
        },
        additionalProperties: false,
    }),
    createTool("discover_schema", "Retrieve the normalized contract and version history for a session.", {
        type: "object",
        required: ["session_id"],
        properties: {
            org_token: orgTokenProperty,
            session_id: sessionIdProperty,
        },
        additionalProperties: false,
    }),
    createTool("generate_integration", "Generate integration files for the consumer stack.", {
        type: "object",
        required: ["session_id", "consumer_context"],
        properties: {
            org_token: orgTokenProperty,
            session_id: sessionIdProperty,
            consumer_context: consumerContext,
        },
        additionalProperties: false,
    }),
    createTool("validate_integration", "Validate generated integration files against the published schema.", {
        type: "object",
        required: ["session_id", "files"],
        properties: {
            org_token: orgTokenProperty,
            session_id: sessionIdProperty,
            files: {
                type: "array",
                items: {
                    type: "object",
                    required: ["filename", "content"],
                    properties: {
                        filename: { type: "string" },
                        content: { type: "string" },
                    },
                    additionalProperties: true,
                },
            },
        },
        additionalProperties: false,
    }),
    createTool("emit_message", "Send a freeform negotiation message within a session.", {
        type: "object",
        required: ["session_id", "message"],
        properties: {
            org_token: orgTokenProperty,
            session_id: sessionIdProperty,
            message: {
                type: "object",
                required: ["text"],
                properties: {
                    text: { type: "string" },
                    kind: { type: "string", default: "note" },
                },
                additionalProperties: true,
            },
        },
        additionalProperties: false,
    }),
    createTool("publish_to_registry", "Publish a normalized schema to the persistent registry.", {
        type: "object",
        required: ["org_token", "service_id", "schema"],
        properties: {
            org_token: orgTokenProperty,
            service_id: serviceIdProperty,
            schema: schemaContract,
            code_samples: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        language: { type: "string" },
                        description: { type: "string" },
                        content: { type: "string" },
                    },
                    additionalProperties: true,
                },
            },
            changelog: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
    }),
    createTool("discover_from_registry", "Retrieve a published schema from the registry without a session.", {
        type: "object",
        required: ["org_token", "service_id"],
        properties: {
            org_token: orgTokenProperty,
            service_id: serviceIdProperty,
            version: { type: "string", default: "latest" },
        },
        additionalProperties: false,
    }),
    createTool("list_registry", "List registry-published services and latest schema versions.", {
        type: "object",
        required: ["org_token"],
        properties: {
            org_token: orgTokenProperty,
            tags: { type: "array", items: { type: "string" } },
            q: { type: "string" },
            limit: { type: "number" },
        },
        additionalProperties: false,
    }),
];
