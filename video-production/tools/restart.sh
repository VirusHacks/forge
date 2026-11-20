#!/bin/zsh
# Restart the demo VS Code instance (separate profile) on a workspace: restart.sh <folder>
cd /Users/dakshjain/Desktop/Hackathons/iit-true-forge/scratch
pkill -f "node hold.mjs"; pkill -f "user-data-dir $PWD/vd"; sleep 3
env -u ELECTRON_RUN_AS_NODE "/Applications/Visual Studio Code.app/Contents/MacOS/Code" --user-data-dir "$PWD/vd" --extensions-dir "$PWD/vx" --extensionDevelopmentPath=/Users/dakshjain/Desktop/Hackathons/iit-true-forge/extension --remote-debugging-port=9333 --disable-workspace-trust --skip-welcome --new-window "$1" > vd.log 2>&1 &
for i in {1..30}; do curl -s localhost:9333/json/list | grep -q "Extension Development Host" && break; sleep 1; done; sleep 4
cd ../video-production/tools && (nohup node hold.mjs > hold.log 2>&1 &) ; sleep 1; echo restarted
