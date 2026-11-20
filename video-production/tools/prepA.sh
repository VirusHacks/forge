#!/bin/zsh
cd /Users/dakshjain/Desktop/Hackathons/iit-true-forge/video-production/tools
timeout 60 node poke.mjs '
await v.key("cmd+shift+p"); await sleep(500); await v.type("Notifications: Clear All", {cps:80}); await sleep(700); await v.key("Enter"); await sleep(600);
await v.webClick("button.icon-btn", "+"); await sleep(600);
await v.click(".tab", "helpers.py"); await sleep(400); await v.click(".monaco-editor .view-lines"); await sleep(300);
await v.key("ctrl+g"); await sleep(300); await v.type("14", {cps: 20}); await v.key("Enter"); await sleep(300);
await v.key("ctrl+g"); await sleep(300); await v.type("27", {cps: 20}); await v.key("Enter"); await sleep(500);
const panel = await v.eval(`!!document.querySelector(".part.panel") && document.querySelector(".part.panel").getBoundingClientRect().height > 0`);
if (panel) { await v.key("cmd+j"); await sleep(500); }
return await v.eval(`document.querySelectorAll(".notification-toast, .notifications-toasts .monaco-list-row").length`);'
