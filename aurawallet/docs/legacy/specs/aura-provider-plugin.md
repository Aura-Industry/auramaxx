# Aura Provider Plugin Contract (v1)

## Capability taxonomy
Allowed declared capabilities:
- `resolve.read`
- `resolve.metadata`
- `resolve.list` (optional)

No write/mutate capability in v1.

## Mandatory policy sequence (deny by default)
For each provider call, runtime checks in order:
1. Trust/signature check
2. Provider API compatibility check
3. Declared capability check
4. Local policy scope check
5. Runtime hard-deny check

Rule precedence: explicit deny > explicit allow > implicit deny.

## Execution boundaries
- Parser package never executes plugins.
- Plugins execute in resolver runtime boundary only.
- Capability escalation attempts must fail with `E_POLICY_CAPABILITY_ESCALATION`.
