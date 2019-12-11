# AMX Mod X VSCode Remote Debugger [WIP]

This is a debug adapter for Amxx Pawn language which allows for remote debugging of scripts. It requires specific setup on
application side. (https://github.com/Garey27/amxx-debugger-server)

## Install from marketplace

* Search AmxxPawn Remote Debugger on marketplace, install, follow steps to install Amxx Deubgger server: https://github.com/Garey27/amxx-debugger-server

## Building

* Clone the project
* Open the project folder in VS Code.
* Press `F5` to build and launch Amxx Debuger in another VS Code window. In that window:
  * Open workspace with amxmodx source files.
  * Switch to the debug viewlet and press the gear dropdown.
  * Select the debug environment "AmxxPawn Debugger".
  * Press `F5` to start debugging.
