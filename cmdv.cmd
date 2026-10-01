@echo off
rem cmdv launcher. Usage: cmdv [folder ...] [--port N] [--browser] [--no-open]
rem With no folder given, serves the current directory.
python "%~dp0cmdv.py" %*
