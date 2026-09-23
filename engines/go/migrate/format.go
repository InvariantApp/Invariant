package main

import "go/format"

// FormatFile is a file's text, before or after gofmt.
type FormatFile struct {
	Path string `json:"path"`
	Text string `json:"text"`
	// Error says why a text could not be formatted; it is then returned as
	// it came.
	Error string `json:"error,omitempty"`
}

// formatFiles runs gofmt over each text. Renaming a key in a composite
// literal changes how gofmt aligns the values beside it, and a migration
// whose edits leave a file gofmt would rewrite is one a reviewer has to
// clean up after.
func formatFiles(files []FormatFile) []FormatFile {
	formatted := make([]FormatFile, 0, len(files))
	for _, file := range files {
		text, err := format.Source([]byte(file.Text))
		if err != nil {
			formatted = append(formatted, FormatFile{Path: file.Path, Text: file.Text, Error: err.Error()})
			continue
		}
		formatted = append(formatted, FormatFile{Path: file.Path, Text: string(text)})
	}
	return formatted
}
