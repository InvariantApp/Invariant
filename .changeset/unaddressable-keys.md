---
"@invariant-app/compiler": patch
---

A Change whose pointer names `__proto__`, `constructor` or `prototype` is refused when it is compiled. The runtime refuses a program that names one when it loads it, and `prototype` compiled without a word, so the release gate passed and the program failed only on deploy.
