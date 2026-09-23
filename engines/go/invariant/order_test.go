package invariant

import (
	"math/rand/v2"
	"regexp"
	"strings"
	"testing"
)

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

// The hand-written scan means what the reference's regular expression means,
// on every string, not only on the ones a person thought of.
func TestBeyondDoubleIsTheReferencePattern(t *testing.T) {
	pattern := regexp.MustCompile(`\d{16}|\.\d*0(?:[^\d]|$)|[\d.][eE]|-0(?:[^.\d]|$)`)
	alphabet := []byte("0123456789.eE+-x\" ")
	random := rand.New(rand.NewPCG(1, 2))
	for range 20_000 {
		text := make([]byte, random.IntN(40))
		for index := range text {
			text[index] = alphabet[random.IntN(len(alphabet))]
		}
		if beyondDouble(text) != pattern.Match(text) {
			t.Fatalf("%q: scan says %v, pattern says %v", text, beyondDouble(text), pattern.Match(text))
		}
	}
	long := []byte(strings.Repeat("7", 16))
	if !beyondDouble(long) || beyondDouble(long[1:]) {
		t.Fatal("sixteen digits in a row, and not fifteen")
	}
}

// A string is written as JSON.stringify writes it, down to the byte: Go's own
// encoder escapes <, > and &, which the reference does not.
func TestStringsAreWrittenAsTheReferenceWritesThem(t *testing.T) {
	out, err := Marshal("<a&b>  \u0001\u001f\t\n\"\\é😀")
	if err != nil {
		t.Fatal(err)
	}
	// What node prints for JSON.stringify of the same string.
	const want = "\"<a&b>  \\u0001\\u001f\\t\\n\\\"\\\\é😀\""
	if string(out) != want {
		t.Fatalf("got %s, want %s", out, want)
	}
}
