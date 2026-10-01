# A terminal film of example 23, rendered by vhs (https://github.com/charmbracelet/vhs): `vhs examples/23-langchain-kb-agent.tape`
# from packages/receipts. Deterministic, no narration, no API key. Outputs land beside the tape unless Output is changed.
Output examples-out/langchain-kb-agent.mp4
Output examples-out/langchain-kb-agent.gif
Set Shell bash
Set FontSize 15
Set Width 1360
Set Height 1040
Set Theme "Catppuccin Latte"
Set Padding 24
Set TypingSpeed 40ms
Hide
Type "clear" Enter
Show
Type "# A LangChain agent under custody: a docs agent that reads runbooks and writes notes." Enter
Type "# Every tool call becomes a signed receipt; a write outside notes/ is refused before it happens." Enter
Sleep 2s
Type "node examples/23-langchain-kb-agent.ts" Sleep 500ms Enter
Sleep 12s
Type "# The refused write, verified from the shell with the public key and the log copy: the same check anyone can run." Enter
Sleep 2s
Type "node src/cli.ts verify examples-out/23-langchain-kb-agent/receipts/$(ls examples-out/23-langchain-kb-agent/receipts | head -1) --issuer-key examples-out/23-langchain-kb-agent/keys/docs-agent.pub --log examples-out/23-langchain-kb-agent/log.jsonl | head -14" Sleep 500ms Enter
Sleep 9s
