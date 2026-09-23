package invariant

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"
)

// A body that outlasts its time budget is stopped, rather than finished late.
//
// Sixty instructions, each within the fan-out cap, over nine thousand items:
// shorter than the step interval, so before the clock was also read after
// every instruction it was never read at all, and this ran to the end against
// a five millisecond budget. The TypeScript runtime has the same test, in
// proving/threats/bombs.test.ts.
func TestTimeBudgetStopsAShortProgramOverALargeBody(t *testing.T) {
	instrs := make([]map[string]any, 60)
	item := map[string]int{}
	for i := range instrs {
		instrs[i] = map[string]any{
			"k": "move", "from": fmt.Sprintf("/items/*/f%d", i),
			"to": fmt.Sprintf("/items/*/g%d", i), "c": "chg_many",
		}
		item[fmt.Sprintf("f%d", i)] = 1
	}
	program, _ := json.Marshal(map[string]any{
		"irVersion": 2, "api": "bomb", "current": "sha256:0", "currentLabel": "new",
		"contracts": map[string]any{"old": map[string]any{
			"label": "old", "routes": []any{}, "behaviors": []any{}, "retired": []any{},
			"sites": map[string]any{"post /items": map[string]any{"request": instrs}},
		}},
	})
	runtime, err := Load(program, Options{
		Limits:   Limits{MaxMatches: 10_000, TimeBudget: 5 * time.Millisecond},
		Identity: oldByDefault,
	})
	if err != nil {
		t.Fatal(err)
	}
	items := make([]map[string]int, 9_000)
	for i := range items {
		items[i] = item
	}
	body, _ := json.Marshal(map[string]any{"items": items})
	_, _, err = runtime.TransformRequest("old", "post /items", body)
	var transform *TransformError
	if !errors.As(err, &transform) || transform.Kind != "time" {
		t.Fatalf("want a time budget refusal, got %v", err)
	}
}
