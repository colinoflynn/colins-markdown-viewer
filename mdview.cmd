@echo off
rem mdview launcher. Usage: mdview [folder ...] [--port N] [--browser] [--no-open]
rem With no folder given, serves the current directory.
python "%~dp0server.py" %*
