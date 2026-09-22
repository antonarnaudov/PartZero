# Skill template

A part-family skill is a folder:

```
SKILL.md          when to use, design rules, pitfalls
params.ts         zod schema: units, ranges, defaults, derived params
template.cad.ts   CadScript op template
verify.ts         per-op checks + final tests
examples/         3–5 reference instances + renders
```

Instantiating a skill expands into ordinary, editable features. See docs/ARCHITECTURE.md §4.
