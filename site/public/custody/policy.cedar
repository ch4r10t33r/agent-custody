// The policy this repository's own agent runs under. Everything is recorded; two things are refused outright, and the
// refusal is a receipt too: rewriting shared history, and deleting the tree from under the tests.
permit(principal, action, resource);

forbid(principal, action == Action::"Bash", resource)
when { context.args has command && context.args.command like "*git push*--force*" };

forbid(principal, action == Action::"Bash", resource)
when { context.args has command && context.args.command like "*git push*-f *" };

forbid(principal, action == Action::"Bash", resource)
when { context.args has command && context.args.command like "*rm -rf /*" };
