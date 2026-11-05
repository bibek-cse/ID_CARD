#!/usr/bin/env python3
"""
Launcher for the CVPR Lab ID-card web interface (code lives in idcard/).

    pip install -r requirements.txt
    python app.py                         # http://127.0.0.1:7860
    python app.py --host 0.0.0.0          # reachable on the lab network
    python app.py --auth lab:secret       # require a login (or env IDCARD_AUTH)

Hugging Face Spaces runs this file automatically.
"""
import os
import runpy
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.join(HERE, "idcard")
sys.path.insert(0, PKG)          # so `import idcard` finds idcard/idcard.py, not the folder
os.chdir(PKG)
runpy.run_path(os.path.join(PKG, "app.py"), run_name="__main__")
