package invariant

import (
	"fmt"
	"regexp"
	"strings"
)

// DecimalError is arithmetic on text that is not a plain decimal number.
type DecimalError struct{ Message string }

func (e *DecimalError) Error() string { return e.Message }

var plainDecimal = regexp.MustCompile(`^(-?)(\d+)(?:\.(\d+))?$`)

type decimal struct {
	negative bool
	// All significant digits, decimal point removed.
	digits string
	// How many of those digits sit after the decimal point.
	scale int
}

// parseDecimal reads a plain decimal. Exponential notation is refused rather
// than normalised: a transform should not reinterpret a representation the
// caller chose.
func parseDecimal(text string) (decimal, error) {
	match := plainDecimal.FindStringSubmatch(strings.TrimSpace(text))
	if match == nil {
		return decimal{}, &DecimalError{fmt.Sprintf("Not a plain decimal number: %s", text)}
	}
	return decimal{negative: match[1] == "-", digits: match[2] + match[3], scale: len(match[3])}, nil
}

func formatDecimal(value decimal) string {
	var whole, fraction string
	switch {
	case value.scale == 0:
		whole = value.digits
	case len(value.digits) > value.scale:
		whole = value.digits[:len(value.digits)-value.scale]
		fraction = value.digits[len(value.digits)-value.scale:]
	default:
		whole = "0"
		fraction = strings.Repeat("0", value.scale-len(value.digits)) + value.digits
	}
	whole = strings.TrimLeft(whole, "0")
	if whole == "" {
		whole = "0"
	}
	fraction = strings.TrimRight(fraction, "0")
	magnitude := whole
	if fraction != "" {
		magnitude = whole + "." + fraction
	}
	// Negative zero is not a distinct JSON number.
	if magnitude == "0" {
		return "0"
	}
	if value.negative {
		return "-" + magnitude
	}
	return magnitude
}

// shiftDecimal multiplies by 10^exponent exactly, by moving the decimal point.
func shiftDecimal(text string, exponent int) (string, error) {
	value, err := parseDecimal(text)
	if err != nil {
		return "", err
	}
	scale := value.scale - exponent
	if scale <= 0 {
		return formatDecimal(decimal{
			negative: value.negative,
			digits:   value.digits + strings.Repeat("0", -scale),
		}), nil
	}
	digits := value.digits
	if len(digits) < scale+1 {
		digits = strings.Repeat("0", scale+1-len(digits)) + digits
	}
	return formatDecimal(decimal{negative: value.negative, digits: digits, scale: scale}), nil
}
