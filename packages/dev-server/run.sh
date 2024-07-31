#!/bin/bash
HOME=/home/ubuntu
##############################################################
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion

## pnpm
#export PNPM_HOME="/home/ubuntu/.local/share/pnpm"
#case ":$PATH:" in
#  *":$PNPM_HOME:"*) ;;
#  *) export PATH="$PNPM_HOME:$PATH" ;;
#esac
## pnpm end
###############################################################
RUNNING_PROCESSES=$(./check.sh)
if [ $? -eq 0 ]; then
  echo '# Found running vendure processes!'
  echo $RUNNING_PROCESSES
  echo '# Stopping processes!'
  ./stop.sh
fi

echo '# Running process!'
nohup yarn start \
    >> logs/vendure.log \
    2>&1 &
