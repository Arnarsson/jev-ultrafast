"""jev-do 'goal' [url] — run one goal in a visible tab and leave the result open."""

import argparse

from jev_ultrafast import Agent

parser = argparse.ArgumentParser()
parser.add_argument("goal")
parser.add_argument("url", nargs="?", default="https://www.google.com/?hl=en")
args = parser.parse_args()

agent = Agent(args.url, args.goal)
for state in agent.run():
    last = state["history"][-1] if state["history"] else {}
    action = f"{last.get('operation', '')} {last.get('action', '')[:50]}"
    print(f"{state['elapsed_ms']:>5} ms  {state['status']:<9} {action}")
print(f"\n{state['status'].upper()} in {state['elapsed_ms'] / 1000:.1f}s: {state['page']['url']}")
