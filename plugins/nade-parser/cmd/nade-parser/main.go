package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"nadesoulpars/pkg/parser"
	"os"
)

func main() {
	info := flag.Bool("plugin-info", false, "Print plugin metadata")
	parse := flag.Bool("parse", false, "Parse demo")
	replay := flag.Bool("replay", false, "Collect a 2D replay")
	sampleFPS := flag.Float64("sample-fps", 16, "Replay sample frequency (1 to 64)")
	demo := flag.String("demo", "", "Demo path")
	output := flag.String("output", "", "Result path")
	flag.Parse()
	if *info {
		fmt.Println(`{"name":"nade-parser","version":"0.3.0","protocol_version":2,"capabilities":["replay_v1"]}`)
		return
	}
	if *parse == *replay || *demo == "" || *output == "" {
		fmt.Fprintln(os.Stderr, "Use --parse or --replay --demo <path> --output <path|->")
		os.Exit(2)
	}
	if *replay {
		out := os.Stdout
		var err error
		if *output != "-" {
			out, err = os.Create(*output)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
		}
		err = parser.ParseReplayFileStreaming(*demo, parser.ReplayOptions{SampleFPS: *sampleFPS}, out)
		if out != os.Stdout {
			if closeErr := out.Close(); err == nil {
				err = closeErr
			}
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	items, err := parser.ParseAndConvertWithOptions(*demo, parser.DefaultOutputOptions())
	if err == nil {
		result := map[string]any{"version": 1, "canonical_grenades": items}
		if *output == "-" {
			err = json.NewEncoder(os.Stdout).Encode(result)
		} else {
			var data []byte
			data, err = json.Marshal(result)
			if err == nil {
				err = os.WriteFile(*output, data, 0600)
			}
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
