---
"@invariant-app/cli": minor
"@invariant-app/verifier": minor
---

`check --full` stands up builds the way a provider who is not written in Node has them. `build.head` can be an image, a Compose file or a running environment as well as a command, and `build.head.proxy: true` puts Invariant's proxy in front of it, running the program this check just compiled, so the comparison is of this release's adapter rather than whichever was compiled last. A released contract's build can be a Compose file (`build.contracts.<label>.compose`), started as its own project on `${PORT}` and taken down with its volumes after each start. Images are pulled before the readiness clock starts, `build.readyTimeout` gives a slow service minutes rather than 30 seconds, and `build.startPer: contract` starts each build once per run and asks it every scenario of a contract in turn, three starts in all instead of three per scenario. The differential evidence says where the current build came from too.

The calibration now finds values the old build read from the clock at a coarser grain than the second its two runs straddle: a minute, a day, a time with no zone. Both runs answering with a time inside their own window marks the path volatile, found rather than listed, and the evidence counts them. The verifier exports `clockPaths`.
