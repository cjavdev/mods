import re, sys, html
P256 = None
def x256(n):
    base=[(0,0,0),(205,49,49),(13,188,121),(229,229,16),(36,114,200),(188,63,188),(17,168,205),(229,229,229),
          (102,102,102),(241,76,76),(35,209,139),(245,245,67),(59,142,234),(214,112,214),(41,184,219),(229,229,229)]
    if n<16: return base[n]
    if n<232:
        n-=16; v=[0,95,135,175,215,255]; return (v[n//36],v[n//6%6],v[n%6])
    g=8+(n-232)*10; return (g,g,g)
def line2html(s):
    out=[]; st={}
    for m in re.finditer(r'\x1b\[([0-9;]*)m|([^\x1b]+)', s):
        if m.group(2) is not None:
            css=[]
            fg=st.get('fg'); bg=st.get('bg')
            if st.get('inv'): fg,bg=(bg or (13,17,23)),(fg or (230,237,243))
            if fg: css.append('color:rgb(%d,%d,%d)'%fg)
            if bg and bg!=(0,0,0): css.append('background:rgb(%d,%d,%d)'%bg)
            if st.get('bold'): css.append('font-weight:700')
            if st.get('dim'): css.append('opacity:.6')
            if st.get('it'): css.append('font-style:italic')
            t=html.escape(m.group(2))
            out.append('<span style="%s">%s</span>'%(';'.join(css),t) if css else t); continue
        codes=[int(c) if c else 0 for c in m.group(1).split(';')]
        i=0
        while i<len(codes):
            c=codes[i]
            if c==0: st={}
            elif c==1: st['bold']=1
            elif c==2: st['dim']=1
            elif c==3: st['it']=1
            elif c==7: st['inv']=1
            elif c==22: st.pop('bold',0); st.pop('dim',0)
            elif c==23: st.pop('it',0)
            elif c==27: st.pop('inv',0)
            elif c==39: st.pop('fg',0)
            elif c==49: st.pop('bg',0)
            elif c in (38,48):
                k='fg' if c==38 else 'bg'
                if codes[i+1]==2: st[k]=tuple(codes[i+2:i+5]); i+=4
                elif codes[i+1]==5: st[k]=x256(codes[i+2]); i+=2
            elif 30<=c<=37: st['fg']=x256(c-30)
            elif 90<=c<=97: st['fg']=x256(c-90+8)
            i+=1
    return ''.join(out)
def page(lines, title):
    body='\n'.join(line2html(l) for l in lines)
    return f'''<!doctype html><meta charset=utf-8><style>
body{{margin:0;background:#0b0e14;padding:28px;display:inline-block}}
.win{{background:#0d1117;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.6);border:1px solid #30363d;overflow:hidden;display:inline-block}}
.bar{{height:30px;background:#161b22;display:flex;align-items:center;padding:0 12px;gap:8px;color:#8b949e;font:12px -apple-system,sans-serif}}
.d{{width:12px;height:12px;border-radius:50%}}
.t{{flex:1;text-align:center;margin-right:52px}}
pre{{margin:0;padding:14px 18px;color:#e6edf3;font:14px/1.35 Menlo,"SF Mono",monospace;white-space:pre}}
</style><div class=win><div class=bar><span class=d style="background:#ff5f57"></span><span class=d style="background:#febc2e"></span><span class=d style="background:#28c840"></span><span class=t>{html.escape(title)}</span></div><pre>{body}</pre></div>'''
if __name__=='__main__':
    src,dst,n,title=sys.argv[1],sys.argv[2],int(sys.argv[3]),sys.argv[4]
    lines=open(src,encoding='utf-8').read().split('\n')
    lines=[l for l in lines if 'Transcript saving is off' not in l]
    while lines and not re.sub(r'\x1b\[[0-9;]*m','',lines[-1]).strip(): lines.pop()
    lines=[l.rstrip() for l in lines[-n:]]
    open(dst,'w').write(page(lines,title))
