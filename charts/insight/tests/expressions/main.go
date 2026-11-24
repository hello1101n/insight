package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/Masterminds/sprig/v3"
	"github.com/expr-lang/expr"
)

func toJSON(value any) (string, error) {
	data, err := json.Marshal(value)
	return string(data), err
}

type Input struct {
	Expressions []string
	Resources   string
}

func evaluate() error {
	var input Input
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		return err
	}
	env := map[string]any{
		"inputs": map[string]any{"parameters": map[string]any{"sync_resources": input.Resources}},
		"sprig":  sprig.GenericFuncMap(),
		"toJson": toJSON,
	}
	results := make([]any, 0, len(input.Expressions))
	for index, expression := range input.Expressions {
		program, err := expr.Compile(expression, expr.Env(env))
		if err != nil {
			return fmt.Errorf("compile tag %d: %w", index, err)
		}
		result, err := expr.Run(program, env)
		if err != nil {
			return fmt.Errorf("evaluate tag %d: %w", index, err)
		}
		results = append(results, result)
	}
	return json.NewEncoder(os.Stdout).Encode(results)
}

func main() {
	if err := evaluate(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
