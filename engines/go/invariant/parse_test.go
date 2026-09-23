package invariant

import (
	"bytes"
	"encoding/json"
	"math/rand/v2"
	"strconv"
	"testing"
)

// The parser accepts exactly the JSON the standard library accepts, and reads
// it to the same values, on text built to be nearly JSON as often as it is
// JSON.
func TestParserAgreesWithTheStandardLibrary(t *testing.T) {
	pieces := []string{
		"{", "}", "[", "]", ",", ":", " ", "\n", `"a"`, `"b\"c"`, `"é"`, `"😀"`,
		"0", "-0", "1", "12.5", "-3e2", "1E+2", "01", "1.", ".5", "-", "true", "false", "null",
		"tru", `"`, `\`, `"\x"`, `"\u12"`,
	}
	random := rand.New(rand.NewPCG(3, 4))
	for range 50_000 {
		var text []byte
		for range random.IntN(12) + 1 {
			text = append(text, pieces[random.IntN(len(pieces))]...)
		}
		ours, err := Parse(text)
		if (err == nil) != json.Valid(text) {
			t.Fatalf("%q: ours %v, standard library says valid is %v", text, err, json.Valid(text))
		}
		if err != nil {
			continue
		}
		decoder := json.NewDecoder(bytes.NewReader(text))
		decoder.UseNumber()
		var theirs any
		if err := decoder.Decode(&theirs); err != nil {
			t.Fatal(err)
		}
		if !sameValue(ours, theirs) {
			t.Fatalf("%q: ours %#v, standard library %#v", text, ours, theirs)
		}
	}
}

func sameValue(ours, theirs any) bool {
	switch v := ours.(type) {
	case *Object:
		other, ok := theirs.(map[string]any)
		if !ok || len(other) != v.Len() {
			return false
		}
		for _, key := range v.Keys() {
			value, _ := v.Get(key)
			if !sameValue(value, other[key]) {
				return false
			}
		}
		return true
	case *Array:
		other, ok := theirs.([]any)
		if !ok || len(other) != len(v.Items) {
			return false
		}
		for index, item := range v.Items {
			if !sameValue(item, other[index]) {
				return false
			}
		}
		return true
	case Number:
		// A body with a number a double might not hold keeps every number's
		// digits as written, as the reference does; any other is read as a
		// double and written as JavaScript writes it.
		other, ok := theirs.(json.Number)
		if !ok {
			return false
		}
		if string(v) == other.String() {
			return true
		}
		read, err := strconv.ParseFloat(other.String(), 64)
		return err == nil && jsNumberText(read) == string(v)
	}
	return ours == theirs
}

// A double rounds integers past 2^53: Qdrant's suite sends a limit of
// u64::MAX, which read as a double comes back as 18446744073709552000, out of
// range for the u64 it was sent as.
func TestKeepsAnIntegerPastTwoToTheFiftyThree(t *testing.T) {
	body := []byte(`{"limit":18446744073709551615,"vector":[0.1,0.2]}`)
	value, err := Parse(body)
	if err != nil {
		t.Fatal(err)
	}
	out, err := Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != string(body) {
		t.Fatalf("got %s, want %s", out, body)
	}
}
