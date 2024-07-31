#!/bin/bash

ps -ef | grep vendure | grep node | grep -v grep | awk '{ print $2 }' | xargs kill
