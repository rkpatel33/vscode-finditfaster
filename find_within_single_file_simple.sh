#!/usr/bin/env bash
set -uo pipefail  # No -e to support write to canary file after cancel

. "$EXTENSION_PATH/shared.sh"

# If we only have one directory to search, invoke commands relative to that directory
PATHS=("$@")
SINGLE_DIR_ROOT=''
# if [ ${#PATHS[@]} -eq 1 ]; then
#   SINGLE_DIR_ROOT=${PATHS[0]}
#   PATHS=()
#   cd "$SINGLE_DIR_ROOT" || exit
# fi

# 1. Search for text in files using Ripgrep
# 2. Interactively restart Ripgrep with reload action
# 3. Open the file
# shellcheck disable=SC2207
RG_PREFIX=(rg
    --column
    --hidden
    $(array_join ${USE_GITIGNORE_OPT+"${USE_GITIGNORE_OPT[@]}"})
    --line-number
    --no-heading
    --color=always
    --smart-case
    --colors 'match:fg:green'
    --colors 'path:fg:white'
    --colors 'path:style:nobold'
    --glob "'!**/.git/'"
    $(array_join "${GLOBS[@]+"${GLOBS[@]}"}")
)
if [[ ${#TYPE_FILTER_ARR[@]} -gt 0 ]]; then
    RG_PREFIX+=("$(printf "%s " "${TYPE_FILTER_ARR[@]}")")
fi
RG_PREFIX+=(" 2> /dev/null")

PREVIEW_ENABLED=${FIND_WITHIN_FILES_PREVIEW_ENABLED:-1}
PREVIEW_ENABLED=0
PREVIEW_COMMAND=${FIND_WITHIN_FILES_PREVIEW_COMMAND:-'bat --decorations=always --color=always {1} --highlight-line {2} --style=header,grid'}
PREVIEW_WINDOW=${FIND_WITHIN_FILES_PREVIEW_WINDOW_CONFIG:-'right:border-left:50%:+{2}+3/3:~3'}
HAS_SELECTION=${HAS_SELECTION:-}
RESUME_SEARCH=${RESUME_SEARCH:-}
FUZZ_RG_QUERY=${FUZZ_RG_QUERY_SINGLE_FILE:-}
# We match against the beginning of the line so everything matches but nothing gets highlighted...
QUERY=''
INITIAL_QUERY=''  # Don't show initial "^" regex in fzf
INITIAL_POS='1'
if [[ "$RESUME_SEARCH" -eq 1 ]]; then
    # ... or we resume the last search if that is desired
    if [[ -f "$LAST_QUERY_FILE" ]]; then
        QUERY="$(tail -n 1 "$LAST_QUERY_FILE")"
        INITIAL_QUERY="$QUERY"  # Do show the initial query when it's not "^"
        if [[ -f "$LAST_POS_FILE" ]]; then
            read -r pos < "$LAST_POS_FILE"
            ((pos++)) # convert index to position
            INITIAL_POS="$pos"
        fi
    fi
elif [[ "$HAS_SELECTION" -eq 1 ]]; then
    # ... or against the selection if we have one
    QUERY="$(cat "$SELECTION_FILE")"
    INITIAL_QUERY="$QUERY"  # Do show the initial query when it's not "^"
fi

# Some backwards compatibility stuff
if [[ $FZF_VER_PT1 == "0.2" && $FZF_VER_PT2 -lt 7 ]]; then
    if [[ "$PREVIEW_COMMAND" != "$FIND_WITHIN_FILES_PREVIEW_COMMAND" ]]; then
        PREVIEW_COMMAND='bat {1} --color=always --highlight-line {2} --line-range {2}:'
    fi
    if [[ "$PREVIEW_WINDOW" != "$FIND_WITHIN_FILES_PREVIEW_WINDOW_CONFIG" ]]; then
        PREVIEW_WINDOW='right:50%'
    fi
fi

PREVIEW_STR=()
if [[ "$PREVIEW_ENABLED" -eq 1 ]]; then
    PREVIEW_STR=(--preview "$PREVIEW_COMMAND" --preview-window "$PREVIEW_WINDOW")
fi

# dummy fallback binding because fzf v<0.36 does not support `load` and I did not figure out how to
# conditionally set the entire binding string (i.e., with the "--bind" part)
RESUME_POS_BINDING="backward-eof:ignore"
if [[ "$(printf '%s\n' "$FZF_VER_NUM" "0.36" | sort -V | head -n 1)" == "0.36" ]]; then
    # fzf version is greater or equal 0.36, so the `load` trigger is supported
    RESUME_POS_BINDING="load:pos($INITIAL_POS)"
fi

RG_QUERY_PARSING="{q}"
if [[ "$FUZZ_RG_QUERY" -eq 1 ]]; then
    RG_QUERY_PARSING="\$(echo {q} | sed 's/ /.*/g')"
    QUERY="$(echo $QUERY | sed 's/ /.*/g')"
fi

RG_PREFIX_STR=$(array_join "${RG_PREFIX+"${RG_PREFIX[@]}"}")
RG_PREFIX_STR="${RG_PREFIX+"${RG_PREFIX[@]}"}"
FZF_CMD="${RG_PREFIX+"${RG_PREFIX[@]}"} '$QUERY' $(array_join "${PATHS[@]+"${PATHS[@]}"}")"

# # echo $FZF_CMD
# echo "$RG_PREFIX_STR"
# # exit 1
# # IFS sets the delimiter
# # -r: raw
# # -a: array
# # Quick note on ${PREVIEW_STR[@]+"${PREVIEW_STR[@]}"}: Don't ask.
# # https://stackoverflow.com/q/7577052/888916
# IFS=: read -ra VAL < <(
#   FZF_DEFAULT_COMMAND="$FZF_CMD" \
#   fzf --ansi \
#       --cycle \
#       --bind "change:reload:sleep 0.1; $RG_PREFIX_STR $RG_QUERY_PARSING $(array_join "${PATHS[@]+"${PATHS[@]}"}") || true" \
#       --delimiter : \
#       --history $LAST_QUERY_FILE \
#       --bind "enter:execute(echo {n} > $LAST_POS_FILE)+accept" \
#       --bind "$RESUME_POS_BINDING" \
#       --phony --query "$INITIAL_QUERY" \
#       ${PREVIEW_STR[@]+"${PREVIEW_STR[@]}"} \
# )
# # Output is filename, line number, character, contents

# # DEBUG
# echo TESTING > "$SHELL_DEBUG_FILE"
# # echo PATHS $PATHS >> "$SHELL_DEBUG_FILE"
# echo FZF_DEFAULT_COMMAND=$FZF_DEFAULT_COMMAND >> "$SHELL_DEBUG_FILE"
# echo FZF_CMD=$FZF_CMD >> "$SHELL_DEBUG_FILE"
# echo RG_PREFIX_STR=$RG_PREFIX_STR >> "$SHELL_DEBUG_FILE"
# echo RG_QUERY_PARSING=$RG_QUERY_PARSING >> "$SHELL_DEBUG_FILE"
# echo RESUME_POS_BINDING=$RESUME_POS_BINDING >> "$SHELL_DEBUG_FILE"
# echo INITIAL_QUERY=$INITIAL_QUERY >> "$SHELL_DEBUG_FILE"
# echo LAST_POS_FILE=$LAST_POS_FILE >> "$SHELL_DEBUG_FILE"
# echo LAST_QUERY_FILE=$LAST_QUERY_FILE >> "$SHELL_DEBUG_FILE"
# echo ARGS=$@ >> "$SHELL_DEBUG_FILE"
# echo VAL=$VAL >> "$SHELL_DEBUG_FILE"

# # This is the only thing passed into the script, so its the filename
# ARG_FILENAME=$@

# if [[ ${#VAL[@]} -eq 0 ]]; then
#     echo canceled
#     echo "1" > "$CANARY_FILE"
#     exit 1
# else
#     FILENAME=${VAL[0]}:${VAL[1]}:${VAL[2]}
#     if [[ -n "$SINGLE_DIR_ROOT" ]]; then
#         echo "$SINGLE_DIR_ROOT/$FILENAME" > "$CANARY_FILE"
#     else
#         # echo "$FILENAME" > "$CANARY_FILE"
#         echo "$ARG_FILENAME":$VAL > "$CANARY_FILE"
#     fi
# fi


FILE_PATH=$@
FILE=$@

# SELECTED_LINE=$(cat "$FILE_PATH" | nl -ba | fzf --delimiter ':' )
# LINE_NUMBER=$(echo "$SELECTED_LINE" | cut -f1)

# SELECTED_LINE=$(rg --column --hidden --line-number --no-heading --color=always --smart-case --colors match:fg:green --colors path:fg:white --colors path:style:nobold 2> /dev/null '^' $FILE \
# 	| fzf --ansi --no-sort --reverse --delimiter : --nth 3.. --preview "bat $FILE --color=always -H {1} --line-range {1}:" )

# Use rg to cat out the file with line numbers, then pipe to fzf

# OLD:
# Preview from match line to end of file
# --preview "bat $FILE --color=always -H {1} --line-range {1}:"

# 'rg' is used for searching the file:
#   --line-number      : Outputs the line number of each match.
#   --no-heading       : Omits file headers when more than one file is searched.
#   --color=always     : Forces color output even when piping to another command.
#   --smart-case       : Searches case-insensitively unless the query contains uppercase letters.
#   --colors match:fg:green etc. : Customizes the color of the match, path, and style.
#   2> /dev/null       : Redirects any error messages to /dev/null (effectively ignoring them).
# '^'                  : The pattern being searched; '^' represents the start of a line.
# $FILE                : The file being searched.

# 'fzf' is used for selecting from the search results:
#   --query "$QUERY"   : Pre-fills the search input with the value of $QUERY.
#   --ansi             : Enables ANSI color codes support.
#   --no-sort          : Disables sorting; the original order from 'rg' is preserved.
#   --reverse          : Starts the list from the bottom of the screen.
#   --delimiter :      : Sets ':' as the delimiter for splitting fields.
#   --nth 2..          : Hides the first field (line number) in the fzf UI.
#   --color, --border, etc. : Customizes the appearance of the 'fzf' interface.
#   --preview          : Uses 'bat' to display a preview of the file with the highlighted match.

# The final 'cut' command extracts the line number from the selection.

LINE_NUMBER=$(
rg \
	--line-number \
	--no-heading \
	--color=always \
	--smart-case \
	--colors match:fg:green \
	--colors path:fg:white \
	--colors path:style:nobold 2> /dev/null '^' $FILE \
	| fzf \
        --query "$QUERY" \
		--ansi \
		--no-sort \
		--reverse \
		--delimiter : \
		--nth 2.. \
		--color='dark' \
		--border=double \
		--info=inline \
		--prompt='$>' \
		--pointer='→' \
		--preview "bat $FILE --style=numbers --color=always -H {1} --line-range {1}:" \
		| cut -d':' -f1
)

echo "$FILE_PATH":$LINE_NUMBER > "$CANARY_FILE"