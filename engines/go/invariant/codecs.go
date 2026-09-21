package invariant

import (
	"fmt"
	"math/big"
	"regexp"
	"strconv"
	"strings"
)

// codecRefusal is a value a codec cannot convert exactly, in words that name it.
type codecRefusal struct{ message string }

func (e *codecRefusal) Error() string { return e.message }

func refuse(format string, args ...any) error {
	return &codecRefusal{fmt.Sprintf(format, args...)}
}

var rfc3339 = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$`)

type instant struct {
	ms *big.Int
	// Digits below a millisecond, which only RFC 3339 can carry.
	finer string
}

func floorDiv(a, b int64) int64 {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

// daysFromCivil counts days since 1970-01-01 of a proleptic Gregorian date.
func daysFromCivil(year, month, day int64) int64 {
	y := year
	if month <= 2 {
		y--
	}
	era := floorDiv(y, 400)
	yoe := y - era*400
	shift := int64(9)
	if month > 2 {
		shift = -3
	}
	doy := floorDiv(153*(month+shift)+2, 5) + day - 1
	doe := yoe*365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy
	return era*146097 + doe - 719468
}

func civilFromDays(days int64) (int64, int64, int64) {
	z := days + 719468
	era := floorDiv(z, 146097)
	doe := z - era*146097
	yoe := floorDiv(doe-floorDiv(doe, 1460)+floorDiv(doe, 36524)-floorDiv(doe, 146096), 365)
	doy := doe - (365*yoe + floorDiv(yoe, 4) - floorDiv(yoe, 100))
	mp := floorDiv(5*doy+2, 153)
	day := doy - floorDiv(153*mp+2, 5) + 1
	month := mp + 3
	if mp >= 10 {
		month = mp - 9
	}
	year := yoe + era*400
	if month <= 2 {
		year++
	}
	return year, month, day
}

func daysInMonth(year, month int64) int64 {
	if month == 2 {
		if year%4 == 0 && (year%100 != 0 || year%400 == 0) {
			return 29
		}
		return 28
	}
	switch month {
	case 4, 6, 9, 11:
		return 30
	}
	return 31
}

var (
	msPerDay = big.NewInt(86_400_000)
	earliest = new(big.Int).Mul(big.NewInt(daysFromCivil(0, 1, 1)), msPerDay)
	latest   = new(big.Int).Sub(new(big.Int).Mul(big.NewInt(daysFromCivil(10000, 1, 1)), msPerDay), big.NewInt(1))
)

func parseRFC3339(text string) (instant, error) {
	match := rfc3339.FindStringSubmatch(text)
	if match == nil {
		return instant{}, refuse("%q is not an RFC 3339 date-time", text)
	}
	part := func(index int) int64 {
		value, _ := strconv.ParseInt(match[index], 10, 64)
		return value
	}
	year, month, day, hour, minute, second := part(1), part(2), part(3), part(4), part(5), part(6)
	if month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) {
		return instant{}, refuse("%q names a day that does not exist", text)
	}
	if hour > 23 || minute > 59 {
		return instant{}, refuse("%q names a time that does not exist", text)
	}
	if second > 59 {
		return instant{}, refuse("%q is a leap second, which the epoch cannot count", text)
	}
	var offsetMinutes int64
	if match[8] == "" {
		offsetHours, offsetRest := part(10), part(11)
		if offsetHours > 23 || offsetRest > 59 {
			return instant{}, refuse("%q has an offset that does not exist", text)
		}
		offsetMinutes = offsetHours*60 + offsetRest
		if match[9] == "-" {
			offsetMinutes = -offsetMinutes
		}
	}
	fraction := match[7]
	millisText := fraction
	if len(millisText) > 3 {
		millisText = millisText[:3]
	}
	millisText = (millisText + "000")[:3]
	millis, _ := strconv.ParseInt(millisText, 10, 64)
	ms := new(big.Int).Mul(big.NewInt(daysFromCivil(year, month, day)), msPerDay)
	ms.Add(ms, big.NewInt(((hour*60+minute-offsetMinutes)*60+second)*1000))
	ms.Add(ms, big.NewInt(millis))
	finer := ""
	if len(fraction) > 3 {
		finer = strings.TrimRight(fraction[3:], "0")
	}
	return instant{ms: ms, finer: finer}, nil
}

func pad(n int64, width int) string {
	text := strconv.FormatInt(n, 10)
	if len(text) < width {
		text = strings.Repeat("0", width-len(text)) + text
	}
	return text
}

func formatRFC3339(ms *big.Int) (string, error) {
	if ms.Cmp(earliest) < 0 || ms.Cmp(latest) > 0 {
		return "", refuse("%s ms since the epoch is outside the years RFC 3339 can write", ms.String())
	}
	days := new(big.Int)
	rest := new(big.Int)
	days.DivMod(ms, msPerDay, rest) // Euclidean: rest is never negative
	year, month, day := civilFromDays(days.Int64())
	r := rest.Int64()
	clock := pad(r/3_600_000, 2) + ":" + pad((r/60_000)%60, 2) + ":" + pad((r/1000)%60, 2)
	millis := r % 1000
	fraction := ""
	if millis != 0 {
		fraction = "." + pad(millis, 3)
	}
	return pad(year, 4) + "-" + pad(month, 2) + "-" + pad(day, 2) + "T" + clock + fraction + "Z", nil
}

var wholeNumber = regexp.MustCompile(`^-?\d+$`)

func epochOf(value any, format string) (*big.Int, error) {
	number, ok := value.(Number)
	if !ok {
		unit := "milliseconds"
		if format == "epoch-s" {
			unit = "seconds"
		}
		return nil, refuse("expected a number of %s, found %s", unit, typeName(value))
	}
	text := string(number)
	if !wholeNumber.MatchString(text) {
		return nil, refuse("%s is not a whole number", text)
	}
	out, _ := new(big.Int).SetString(text, 10)
	if format == "epoch-s" {
		out.Mul(out, big.NewInt(1000))
	}
	return out, nil
}

// convertTime re-encodes one instant, exact or refused, or with truncate
// dropping precision toward the earlier instant.
func convertTime(value any, from, to string, truncate bool) (any, error) {
	if from == to {
		return value, nil
	}
	var at instant
	if from == "rfc3339" {
		text, ok := value.(string)
		if !ok {
			return nil, refuse("expected RFC 3339 text, found %s", typeName(value))
		}
		parsed, err := parseRFC3339(text)
		if err != nil {
			return nil, err
		}
		at = parsed
	} else {
		ms, err := epochOf(value, from)
		if err != nil {
			return nil, err
		}
		at = instant{ms: ms}
	}
	if at.finer != "" && !truncate {
		return nil, refuse("the value is more precise than a millisecond")
	}
	switch to {
	case "rfc3339":
		return formatRFC3339(at.ms)
	case "epoch-ms":
		return Number(at.ms.String()), nil
	case "epoch-s":
		remainder := new(big.Int).Mod(at.ms, big.NewInt(1000))
		if remainder.Sign() != 0 && !truncate {
			return nil, refuse("the value has a fraction of a second, which whole seconds cannot hold")
		}
		seconds := new(big.Int).Sub(at.ms, remainder)
		seconds.Quo(seconds, big.NewInt(1000))
		return Number(seconds.String()), nil
	}
	return nil, refuse("unknown time format %s", to)
}

var (
	lowerWord  = regexp.MustCompile(`^[a-z0-9]+$`)
	upperWord  = regexp.MustCompile(`^[A-Z0-9]+$`)
	twoCapital = regexp.MustCompile(`[A-Z]{2}`)
	camelText  = regexp.MustCompile(`^[a-z0-9]+(?:[A-Z][a-z0-9]*)*$`)
	pascalText = regexp.MustCompile(`^(?:[A-Z][a-z0-9]*)+$`)
)

func splitWords(text, separator string, word *regexp.Regexp) []string {
	parts := strings.Split(text, separator)
	for index, part := range parts {
		if !word.MatchString(part) {
			return nil
		}
		parts[index] = strings.ToLower(part)
	}
	return parts
}

func wordsOf(text, style string) []string {
	switch style {
	case "snake":
		return splitWords(text, "_", lowerWord)
	case "screaming":
		return splitWords(text, "_", upperWord)
	case "kebab":
		return splitWords(text, "-", lowerWord)
	case "camel", "pascal":
		if twoCapital.MatchString(text) {
			return nil
		}
		pattern := pascalText
		if style == "camel" {
			pattern = camelText
		}
		if !pattern.MatchString(text) {
			return nil
		}
		var words []string
		start := 0
		for index := 1; index < len(text); index++ {
			if text[index] >= 'A' && text[index] <= 'Z' {
				words = append(words, strings.ToLower(text[start:index]))
				start = index
			}
		}
		return append(words, strings.ToLower(text[start:]))
	}
	return nil
}

func capital(word string) string {
	if word == "" {
		return word
	}
	return strings.ToUpper(word[:1]) + word[1:]
}

func writtenIn(words []string, style string) string {
	switch style {
	case "snake":
		return strings.Join(words, "_")
	case "screaming":
		return strings.ToUpper(strings.Join(words, "_"))
	case "kebab":
		return strings.Join(words, "-")
	case "camel":
		out := make([]string, len(words))
		for index, word := range words {
			if index == 0 {
				out[index] = word
			} else {
				out[index] = capital(word)
			}
		}
		return strings.Join(out, "")
	case "pascal":
		out := make([]string, len(words))
		for index, word := range words {
			out[index] = capital(word)
		}
		return strings.Join(out, "")
	}
	return ""
}

// convertCase rewrites one identifier in another case, refusing what cannot
// be read back.
func convertCase(value any, from, to string) (any, error) {
	text, ok := value.(string)
	if !ok {
		return nil, refuse("expected text to recase, found %s", typeName(value))
	}
	if from == to {
		return text, nil
	}
	words := wordsOf(text, from)
	if words == nil {
		return nil, refuse("%q is not written in %s case", text, from)
	}
	out := writtenIn(words, to)
	back := wordsOf(out, to)
	if back == nil || writtenIn(back, from) != text {
		return nil, refuse("%q cannot be written in %s case and read back", text, to)
	}
	return out, nil
}

// typeName names a value's kind as the reference's messages do.
func typeName(value any) string {
	switch value.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "boolean"
	case Number:
		return "number"
	default:
		return "object"
	}
}
