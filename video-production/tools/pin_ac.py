import re, edl
D = "/Users/dakshjain/Desktop/Hackathons/iit-true-forge/video-production/composition/compositions/"
def pin(fname, comp, times, total):
    s = open(D + fname).read()
    for k, (st, d) in times.items():
        s, n = re.subn(rf'id="{k}" class="([^"]*)" data-start="[\d.]+" data-duration="[\d.]+"', lambda m: f'id="{k}" class="{m.group(1)}" data-start="{st:.2f}" data-duration="{d:.2f}"', s); assert n == 1, k
        s, n = re.subn(rf'pop\("#{k}", [\d.]+\)', f'pop("#{k}", {st:.2f})', s)
        s = re.sub(rf'(tl.fromTo\("#{k}", \{{ opacity: 0, x: 30 \}}, \{{[^}}]*\}}, )[\d.]+\)', rf'\g<1>{st:.2f})', s)
    s = re.sub(r'tl.to\(\{\}, \{ duration: 0.1 \}, [\d.]+\);', f'tl.to({{}}, {{ duration: 0.1 }}, {total - 0.1:.2f});', s)
    open(D + fname, "w").write(s)
A = edl.load("taskA"); a = lambda r: edl.at(A, r); TA = A[-1]["edited_end"]
pin("ovA.html", "ovA", {"ova-chip": (0.2, 3.6), "ova-k": (a(7.4), 3.6), "ova-diff": (a(17.9) + 0.1, a(22.9) - a(17.9) - 0.1),
    "ova-hunk": (a(22.9), a(27.5) - a(22.9)), "ova-acc": (a(27.5), 2.4), "ova-false": (a(41.8), a(46.1) - a(41.8) + 0.4),
    "ova-table": (a(52.6), TA - a(52.6))}, TA)
C = edl.load("taskC"); c = lambda r: edl.at(C, r); TC = C[-1]["edited_end"]
pin("ovC.html", "ovC", {"ovc-chip": (0.2, 4.6), "ovc-cfg": (0.8, c(9.0) - 0.8), "ovc-curl": (c(11.0), c(14.0) - c(11.0)),
    "ovc-retry": (c(33.4), c(39.5) - c(33.4)), "ovc-switch": (c(39.6), c(46.5) - c(39.6)), "ovc-clean": (c(60.0), TC - c(60.0))}, TC)
print("A", TA, "zoomA", a(34.5), "C", TC, "zoomC", c(54.8))
