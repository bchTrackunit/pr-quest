#!/usr/bin/env bash
# Binds the release files a later job of the release workflow downloads to the ones the bundle job
# checked. Any job of the run that has run the dependencies' code or the built app could replace
# an artifact while its token is valid, but only a job itself can set its outputs.
#
#   scripts/ci/artifact-hashes.sh list <folder> <artifact>
#     Prints "<sha256>  <artifact>/<name>" for each file in <folder>, sorted: what a bundle job puts
#     in its output once its checks pass. <folder> holds files only.
#   scripts/ci/artifact-hashes.sh check <downloaded artifacts>
#     Stops unless <downloaded artifacts>/<artifact>/<name> are exactly the files that the lists in
#     the BUNDLED_SHA256_* environment variables name, with their SHA-256s: none missing, changed
#     or extra. Every BUNDLED_SHA256_* variable must hold a list.
set -euo pipefail

usage="usage: $0 list <folder> <artifact> | check <downloaded artifacts>"
mode="${1:?$usage}"

fail() {
  echo "::error title=Release files::$1"
  exit 1
}

if command -v sha256sum >/dev/null; then
  checksum=(sha256sum)
else
  checksum=(shasum -a 256)
fi

shopt -s nullglob dotglob

# Adds a line to $list for each file in folder $1, as artifact $2.
list=""
add() {
  local file sum
  for file in "$1"/*; do
    [[ -f "$file" && ! -L "$file" ]] || fail "$file isn't a file."
    # From stdin, so no file name can change how the line looks.
    sum="$("${checksum[@]}" <"$file")" || fail "Can't checksum $file."
    list+="${sum%% *}  $2/$(basename "$file")"$'\n'
  done
}

# Lines $1, sorted, without empty ones.
sorted() {
  printf '%s' "$1" | sed '/^$/d' | LC_ALL=C sort
}

# The name in each line of list $1.
names() {
  cut -c 67- <<<"$1"
}

case "$mode" in
  list)
    folder="${2:?$usage}"
    artifact="${3:?$usage}"
    [[ -d "$folder" ]] || fail "$folder isn't a folder."
    [[ "$artifact" =~ ^[A-Za-z0-9._-]+$ ]] || fail "$artifact isn't an artifact name."
    add "$folder" "$artifact"
    [[ -n "$list" ]] || fail "$folder is empty."
    printf '%s' "$list" | LC_ALL=C sort -k 2
    ;;

  check)
    in="${2:?$usage}"
    [[ -d "$in" ]] || fail "$in isn't a folder."
    vars="$(compgen -v BUNDLED_SHA256_ || true)"
    [[ -n "$vars" ]] || fail "No BUNDLED_SHA256_* variable names the files to expect."
    expected=""
    for var in $vars; do
      # Empty when its bundle job didn't finish, or when GitHub withheld the output because it
      # looked like a secret.
      [[ -n "${!var}" ]] || fail "$var is empty: its bundle job set no SHA-256s."
      while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        [[ "$line" =~ ^[0-9a-f]{64}\ \ [A-Za-z0-9._-]+/[A-Za-z0-9._@+-]+$ ]] ||
          fail "$var has a line that isn't \"<sha256>  <artifact>/<name>\": $line"
        expected+="$line"$'\n'
      done <<<"${!var}"
    done
    expected="$(sorted "$expected")"
    for folder in "$in"/*; do
      [[ -d "$folder" && ! -L "$folder" ]] || fail "$folder isn't an artifact's folder."
      add "$folder" "$(basename "$folder")"
    done
    actual="$(sorted "$list")"
    if [[ "$actual" != "$expected" ]]; then
      expected_names="$(names "$expected")"
      actual_names="$(names "$actual")"
      while IFS= read -r line; do
        name="$(names "$line")"
        if grep -qxF -- "$name" <<<"$actual_names"; then
          echo "Changed since its bundle job checked it: $name"
        else
          echo "Missing: $name"
        fi
      done < <(LC_ALL=C comm -23 <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") | sed '/^$/d')
      while IFS= read -r line; do
        name="$(names "$line")"
        if ! grep -qxF -- "$name" <<<"$expected_names"; then
          echo "No bundle job checked: $name"
        fi
      done < <(LC_ALL=C comm -13 <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") | sed '/^$/d')
      fail "The downloaded files aren't the ones the bundle jobs checked."
    fi
    echo "The $(wc -l <<<"$actual" | tr -d ' ') downloaded files are the ones the bundle jobs checked."
    ;;

  *)
    echo "$usage" >&2
    exit 2
    ;;
esac
