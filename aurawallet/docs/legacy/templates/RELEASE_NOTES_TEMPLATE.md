# Release Notes Template

## Operator changes

- What changed for humans running Aura locally?
- What setup/upgrade action is required?
- How to verify success (`npx aurawallet doctor` output expectation)?

## Agent changes

- What changed for agent auth/token behavior?
- Any profile/scope defaults changed?
- Any remediation for existing automations?

## Verification checklist

```bash
node scripts/validate-job-docs.mjs
npx aurawallet doctor
```

Mark release notes complete only after both checks pass.
