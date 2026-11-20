"""Map a recording time to the edited clip time using the clip's EDL (cuts/speed/holds)."""
import json
CLIPS = "/Users/dakshjain/Desktop/Hackathons/iit-true-forge/video-production/composition/assets/clips"
def load(name): return json.load(open(f"{CLIPS}/{name}.edl.json"))["segments"]
def at(segs, raw, source_hint=""):
    for s in segs:
        if source_hint and source_hint not in s.get("source", source_hint): continue
        if s["rec_start"] - 1e-6 <= raw <= s["rec_end"] + 1e-6:
            return round(s["edited_start"] + (raw - s["rec_start"]) / s["speed"], 3)
    raise ValueError(f"raw {raw} ({source_hint}) not in any kept segment")
