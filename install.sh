#!/bin/sh
# Installs the composed chattr hooks. See hook/install.mjs for flags.
exec node "$(dirname "$0")/hook/install.mjs" "$@"
