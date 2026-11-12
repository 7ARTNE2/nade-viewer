package parser

import (
	"bytes"
	"io"
	"strings"
	"testing"
	"time"
)

func TestReplayProgressReaderReportsActualBytesAndThrottles(t *testing.T) {
	var output bytes.Buffer
	p := newReplayProgressReader(strings.NewReader("abcdefghij"), &output, 10)
	now := p.lastReport
	p.now = func() time.Time { return now }
	buf := make([]byte, 3)
	if _, err := p.Read(buf); err != nil {
		t.Fatal(err)
	}
	if got := output.String(); got != "REPLAY_PROGRESS 0 10\n" {
		t.Fatalf("unexpected early report: %q", got)
	}
	now = now.Add(250 * time.Millisecond)
	if _, err := p.Read(buf); err != nil {
		t.Fatal(err)
	}
	if got := output.String(); got != "REPLAY_PROGRESS 0 10\nREPLAY_PROGRESS 6 10\n" {
		t.Fatalf("unexpected report: %q", got)
	}
	if _, err := io.Copy(io.Discard, p); err != nil {
		t.Fatal(err)
	}
	p.finish()
	if got := output.String(); got != "REPLAY_PROGRESS 0 10\nREPLAY_PROGRESS 6 10\nREPLAY_PROGRESS 10 10\n" {
		t.Fatalf("unexpected final reports: %q", got)
	}
}

func TestReplayProgressReaderFlushesPartialRead(t *testing.T) {
	var output bytes.Buffer
	p := newReplayProgressReader(strings.NewReader("abcdef"), &output, 6)
	if _, err := p.Read(make([]byte, 2)); err != nil {
		t.Fatal(err)
	}
	p.finish()
	if got := output.String(); got != "REPLAY_PROGRESS 0 6\nREPLAY_PROGRESS 2 6\n" {
		t.Fatalf("unexpected partial reports: %q", got)
	}
}
