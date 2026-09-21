package invariant

import "testing"

// The reference runtime holds bodies as JavaScript objects, which list
// array-index keys first and in numeric order. Both engines have to write a
// body the same way, or a form written from one differs from the other.
func TestObjectKeyOrderIsJavaScripts(t *testing.T) {
	parsed, err := Parse([]byte(`{"b":1,"10":2,"9":3,"01":4,"4294967295":5,"4294967294":6}`))
	if err != nil {
		t.Fatal(err)
	}
	out, err := Marshal(parsed)
	if err != nil {
		t.Fatal(err)
	}
	// What node prints for JSON.stringify(JSON.parse(...)) of the same text.
	const want = `{"9":3,"10":2,"4294967294":6,"b":1,"01":4,"4294967295":5}`
	if string(out) != want {
		t.Fatalf("got %s, want %s", out, want)
	}
}
