with open(r'E:\codex\codex-shop\supabase\functions\wxpusher\index.ts', 'r', encoding='utf-8') as f:
    content = f.read()

old = 'url.searchParams.set("second", String(seconds));'
new = 'url.searchParams.set("second", String(seconds));\n  url.searchParams.set("scanCount", "999999999");'
content = content.replace(old, new)

with open(r'E:\codex\codex-shop\supabase\functions\wxpusher\index.ts', 'w', encoding='utf-8') as f:
    f.write(content)

for i, line in enumerate(content.split('\n')[115:121], 116):
    print(f'{i}: {line}')
