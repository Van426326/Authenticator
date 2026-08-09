#!/bin/bash

# Backward-compatible wrapper. npm scripts use build.js directly so builds also
# work from Windows Command Prompt and PowerShell without Bash or WSL.
exec node "$(dirname "$0")/build.js" "$@"
