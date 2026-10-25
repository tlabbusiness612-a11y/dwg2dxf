"""Independent re-read of produced DXF files with ezdxf (not AutoCAD).

    python tools/ezdxf_check.py out/*.dxf

For each file: can ezdxf load it strictly (ezdxf.readfile) or only with
recover mode, what does the auditor report, entity counts in modelspace /
paperspace / blocks, layer count and the modelspace bounding box.
"""
import sys
from collections import Counter

import ezdxf
from ezdxf import bbox, recover


def check(path):
    out = {"file": path}
    try:
        doc = ezdxf.readfile(path)
        out["strict_load"] = "ok"
    except Exception as e:  # noqa: BLE001 - report any failure
        out["strict_load"] = f"FAILED: {type(e).__name__}: {e}"
        doc, auditor = recover.readfile(path)
        out["recover_errors"] = len(auditor.errors)
    auditor = doc.audit()
    out["dxfversion"] = doc.dxfversion
    out["encoding"] = doc.encoding
    out["audit_errors"] = len(auditor.errors)
    out["audit_fixes"] = len(auditor.fixes)
    out["audit_error_samples"] = [str(e.message) for e in auditor.errors[:5]]
    counts = Counter()
    for blk in doc.blocks:
        for e in blk:
            counts[e.dxftype()] += 1
    out["entities_all_blocks"] = sum(counts.values())
    out["types"] = dict(sorted(counts.items()))
    out["layers"] = len(doc.layers)
    try:
        ext = bbox.extents(doc.modelspace(), fast=True)
        out["msp_extents"] = [list(ext.extmin), list(ext.extmax)] if ext.has_data else None
    except Exception as e:  # noqa: BLE001
        out["msp_extents"] = f"error: {e}"
    return out


if __name__ == "__main__":
    import json

    for p in sys.argv[1:]:
        r = check(p)
        types = r.pop("types")
        print(json.dumps(r, ensure_ascii=False))
        print("   ", json.dumps(types))
