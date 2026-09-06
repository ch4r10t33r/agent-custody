// The smallest possible client, standard library only. SIDECAR_URL points at `agent-custody serve`.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
)

func post(url, path string, body any, out any) error {
	b, _ := json.Marshal(body)
	res, err := http.Post(url+path, "application/json", bytes.NewReader(b))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("%s: %s", path, res.Status)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func main() {
	url := os.Getenv("SIDECAR_URL")
	if url == "" {
		url = "http://127.0.0.1:8788/"
	}
	event := map[string]any{"tool": "stripe.refund", "args": map[string]any{"amount": 500}, "session": map[string]any{"id": "go-run", "toolUseId": "call-1"}}
	var policy map[string]any
	if err := post(url, "decide", event, &policy); err != nil {
		panic(err)
	}
	if policy != nil && policy["decision"] == "deny" {
		var denial map[string]any
		_ = post(url, "record", map[string]any{"event": event, "outcome": map[string]any{"status": "denied", "reason": "policy"}, "policy": policy}, &denial)
		fmt.Println("denied")
		os.Exit(1)
	}
	result := map[string]any{"refund_id": "re_go", "amount": 500} // the tool ran here
	var bundle struct {
		Inclusion struct{ TreeSize int `json:"treeSize"` } `json:"inclusion"`
	}
	if err := post(url, "record", map[string]any{"event": event, "outcome": map[string]any{"status": "executed", "result": result}, "policy": policy}, &bundle); err != nil {
		panic(err)
	}
	fmt.Println("go: receipt at tree size", bundle.Inclusion.TreeSize)
	fmt.Println("OK")
}
