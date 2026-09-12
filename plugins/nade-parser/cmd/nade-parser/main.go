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
	demo := flag.String("demo", "", "Demo path")
	output := flag.String("output", "", "Result path")
	flag.Parse()
	if *info {
		fmt.Println(`{"name":"nade-parser","version":"0.1.0","protocol_version":2}`)
		return
	}
	if !*parse || *demo == "" || *output == "" {
		fmt.Fprintln(os.Stderr, "Use --parse --demo <path> --output <path>")
		os.Exit(2)
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
