# Continuous Groups regressions

Run from the repository root with Node.js 22 or newer:

```sh
node --test tests/continuousGroups/*.test.cjs
```

No package installation is required. The loader extracts the sole JavaScript block from `Expressions/continuousGroups.md` and evaluates its numerical functions in a modeled expression environment. These checks do not launch After Effects and are not native host or rendered-motion validation.

Coverage includes observed cumulative circular turning, independently contradictory flanks, transformation/time-reversal invariants, retained antipodal and interval aliasing guards, bounded evidence authority, unavoidable sample aliasing, representable overflow/cancellation in Y excess, closed-loop zero excess, sparse malformed rest probes, and native fallback on genuinely unrepresentable output.

Grouping coverage also preserves the literal sampled-secant contract under explicitly modeled Float32 value storage: a nominal affine law can lose its long-gap exemption after rounding, causing a substantial expression-clock difference from legacy grouping. Explicit `joinAfter` and `splitAfter` remain authoritative for that stored-input example, with join taking precedence. These cases document the representation limitation; they do not assume all numeric properties use Float32 or claim recovery of pre-storage intent.

The tests intentionally distinguish a supported sampled motion model from an animator's intended gesture. Numerical correctness and native-host compatibility do not establish semantic grouping accuracy.
