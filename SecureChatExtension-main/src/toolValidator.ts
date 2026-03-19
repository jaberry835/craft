/**
 * Tool Argument Validator — validates tool-call arguments against the JSON Schema
 * declared in each ToolDefinition.
 *
 * This catches hallucinated / malformed arguments from the model before they
 * reach the tool handler, producing actionable error messages that help the
 * model self-correct on the next iteration.
 *
 * Supports the subset of JSON Schema used by tool definitions:
 *   - type checking (string, number, boolean, array, object)
 *   - required fields
 *   - enum constraints
 *   - nested object properties (one level)
 */

import { ToolDefinition } from './types';

export interface ValidationResult {
    valid: boolean;
    errors: string[];
}

/**
 * Validate arguments against a tool's parameter schema.
 */
export function validateToolArgs(
    toolDef: ToolDefinition,
    args: Record<string, unknown>
): ValidationResult {
    const errors: string[] = [];
    const schema = toolDef.function.parameters;
    const toolName = toolDef.function.name;

    // Check required parameters
    if (schema.required) {
        for (const req of schema.required) {
            if (args[req] === undefined || args[req] === null) {
                errors.push(`Missing required parameter "${req}" for tool "${toolName}".`);
            }
        }
    }

    // If no parameters provided at all, but schema expects some, report that   
    
    // Check each provided argument against the schema
    for (const [key, value] of Object.entries(args)) {
        const propSchema = schema.properties[key] as Record<string, unknown> | undefined;

        if (!propSchema) {
            // Unknown parameter — not fatal, but note it. Models sometimes add extras.
            continue;
        }

        // Type checking
        const expectedType = propSchema.type as string | undefined;
        if (expectedType && value !== undefined && value !== null) {
            const typeError = checkType(key, value, expectedType);
            if (typeError) {
                errors.push(typeError);
            }
        }

        // Enum checking
        const enumValues = propSchema.enum as unknown[] | undefined;
        if (enumValues && value !== undefined && value !== null) {
            if (!enumValues.includes(value)) {
                errors.push(
                    `Parameter "${key}" for tool "${toolName}" must be one of [${enumValues.map(String).join(', ')}], got "${String(value)}".`
                );
            }
        }

        // Nested array item validation (for tools like set_plan with array of objects)
        if (expectedType === 'array' && Array.isArray(value)) {
            const itemSchema = propSchema.items as Record<string, unknown> | undefined;
            if (itemSchema && itemSchema.type === 'object' && itemSchema.required) {
                const itemRequired = itemSchema.required as string[];
                for (let i = 0; i < value.length; i++) {
                    const item = value[i];
                    if (typeof item === 'object' && item !== null) {
                        for (const req of itemRequired) {
                            if ((item as Record<string, unknown>)[req] === undefined) {
                                errors.push(
                                    `Parameter "${key}[${i}]" for tool "${toolName}" is missing required field "${req}".`
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Check that a value matches the expected JSON Schema type.
 * Returns an error string if mismatched, or null if OK.
 *
 * Note: models sometimes send numbers as strings (e.g., "42" instead of 42).
 * We accept coercible string→number and string→boolean since the tool handlers
 * already handle this (e.g., `parseInt(args.startLine as string, 10)`).
 */
function checkType(key: string, value: unknown, expected: string): string | null {
    switch (expected) {
        case 'string':
            if (typeof value !== 'string') {
                return `Parameter "${key}" expected type "string", got "${typeof value}".`;
            }
            break;
        case 'number':
            if (typeof value === 'string') {
                // Accept numeric strings — models often serialize numbers as strings
                if (value !== '' && !isNaN(Number(value))) { return null; }
            }
            if (typeof value !== 'number') {
                return `Parameter "${key}" expected type "number", got "${typeof value}".`;
            }
            break;
        case 'boolean':
            if (typeof value === 'string') {
                if (value === 'true' || value === 'false') { return null; }
            }
            if (typeof value !== 'boolean') {
                return `Parameter "${key}" expected type "boolean", got "${typeof value}".`;
            }
            break;
        case 'array':
            if (!Array.isArray(value)) {
                return `Parameter "${key}" expected type "array", got "${typeof value}".`;
            }
            break;
        case 'object':
            if (typeof value !== 'object' || Array.isArray(value)) {
                return `Parameter "${key}" expected type "object", got "${typeof value}".`;
            }
            break;
    }
    return null;
}

/**
 * Build a lookup map from tool name → ToolDefinition for fast validation.
 */
export function buildToolSchemaMap(definitions: ToolDefinition[]): Map<string, ToolDefinition> {
    const map = new Map<string, ToolDefinition>();
    for (const def of definitions) {
        map.set(def.function.name, def);
    }
    return map;
}
