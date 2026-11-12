package parser

import (
	"fmt"
	"io"
	"time"
)

// replayProgressReader reports bytes supplied to the demo parser, not bytes
// merely hashed beforehand or replay records written afterwards. The parser
// may read ahead into its own buffer, so this represents input I/O progress.
type replayProgressReader struct {
	reader       io.Reader
	output       io.Writer
	total        int64
	read         int64
	lastReported int64
	lastReport   time.Time
	now          func() time.Time
}

func newReplayProgressReader(reader io.Reader, output io.Writer, total int64) *replayProgressReader {
	p := &replayProgressReader{reader: reader, output: output, total: total, now: time.Now}
	p.report()
	return p
}

func (p *replayProgressReader) report() {
	// Each protocol record is one unbuffered write to stderr, independent of
	// the buffered NDJSON stream on stdout. A closed stderr must not break parsing.
	_, _ = fmt.Fprintf(p.output, "REPLAY_PROGRESS %d %d\n", p.read, p.total)
	p.lastReported = p.read
	p.lastReport = p.now()
}

func (p *replayProgressReader) Read(buf []byte) (int, error) {
	n, err := p.reader.Read(buf)
	p.read += int64(n)
	if p.read != p.lastReported && (err != nil || p.read >= p.total || p.now().Sub(p.lastReport) >= 250*time.Millisecond) {
		p.report()
	}
	return n, err
}

// Flush the last actual read count even if the parser stopped without an EOF read.
func (p *replayProgressReader) finish() {
	if p.read != p.lastReported {
		p.report()
	}
}
