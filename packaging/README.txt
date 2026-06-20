RetroWeb - run it on your own machine
=====================================

This is a self-contained build. No installer, no dependencies to set up.

HOW TO RUN
----------
Windows:
  1. Unzip this folder anywhere.
  2. Double-click  start.bat
  3. Your browser opens at http://localhost:3000

macOS / Linux:
  1. Extract this folder anywhere.
  2. Open a Terminal in this folder and run:   ./start.sh
     (or double-click start.sh if your system runs .sh files)
  3. Your browser opens at http://localhost:3000

  macOS note: the app is not code-signed. start.sh clears the quarantine
  flag automatically. If macOS still blocks it, run once:
      xattr -dr com.apple.quarantine .
  then try again, or right-click retroweb > Open.

WHERE TO PUT YOUR ROMS
----------------------
A "roms" folder is created next to the app the first time you run it.
Put ROMs inside it, organized by system folder, for example:

  roms/
    snes/      Super Nintendo games
    genesis/   Sega Genesis / Mega Drive games
    gba/       Game Boy Advance games
    ...

Then click "Rescan" in the web UI (or restart the app) to pick them up.

CONFIG / SAVES
--------------
Settings, scraped artwork and metadata are stored in the "data" folder
next to the app. Back up that folder to keep your library data.

CHANGING THE PORT OR ROM LOCATION
---------------------------------
Set environment variables before launching:
  PORT       web server port            (default 3000)
  ROM_DIR    where your ROMs live       (default ./roms)
  DATA_DIR   where settings are stored  (default ./data)
