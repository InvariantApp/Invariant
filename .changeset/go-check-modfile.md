---
"@invariant-app/migrate-go": patch
---

The check against the new release lets the go command update its copy of go.mod as it needs to. foks-proj/go-foks moved stripe-go from 81 to 82, and after `go get` the copy still wanted updates that `-mod=readonly` refused; reading export data, the loader took the failed build for one that listed no packages, and the check read no file and reported nothing, though `Invoice.Charge` was gone. A load that lists nothing now fails with what the go command said, so the result is marked `unverified` rather than clean, and `filesChecked` says how many files each pass read.
