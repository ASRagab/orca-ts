#!/usr/bin/env bash
set -euo pipefail
controller_started_seconds="$SECONDS"

requested_backend=""
script_dir=""
source_root=""
git_common_dir=""
primary_root=""
mode=live
complexity=simple
phase=setup
launcher_finalization_ready=false

controller_run_until() {
  local term_second="${1:-}"
  local kill_second="${2:-}"
  local controller_wrapper_pid=""
  local controller_child_pid=""
  local controller_child_status=""
  local controller_line=""
  local controller_wait_seconds=0
  local controller_timed_out=false
  local controller_residual_group=false
  local controller_signal_status=0
  local controller_saved_term_trap=""
  local controller_saved_int_trap=""
  local controller_saved_hup_trap=""
  local controller_capture_mode=false
  local controller_capture_draining=false
  local controller_capture_name=""
  local controller_capture_nonce=""
  local controller_capture_payload_seen=false
  local controller_capture_value=""
  local controller_pid_pattern=""
  local controller_protocol_status=0
  local controller_read_result=0
  local controller_payload_prefix=""
  local controller_status_pattern=""

  if [[ ! "$term_second" =~ ^[0-9]+$ ||
    ! "$kill_second" =~ ^[0-9]+$ || "$#" -lt 3 ]]; then
    return 64
  fi
  term_second=$(( 10#$term_second ))
  kill_second=$(( 10#$kill_second ))
  if [[ "$kill_second" -ne $(( term_second + 1 )) ||
    "$SECONDS" -ge "$kill_second" ]]; then
    return 124
  fi
  shift 2
  if [[ "${1:-}" == --capture ]]; then
    if [[ "$#" -lt 3 ||
      ! "${2:-}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      return 64
    fi
    controller_capture_mode=true
    controller_capture_name="$2"
    controller_capture_nonce="orcats${RANDOM}${RANDOM}${RANDOM}${RANDOM}"
    controller_pid_pattern="^${controller_capture_nonce}:pid:([1-9][0-9]*)$"
    controller_payload_prefix="${controller_capture_nonce}:payload:"
    controller_status_pattern="^${controller_capture_nonce}:status:([0-9]+)$"
    shift 2
  fi

  controller_restore_traps() {
    if [[ -n "$controller_saved_term_trap" ]]; then
      eval "$controller_saved_term_trap"
    else
      trap - TERM
    fi
    if [[ -n "$controller_saved_int_trap" ]]; then
      eval "$controller_saved_int_trap"
    else
      trap - INT
    fi
    if [[ -n "$controller_saved_hup_trap" ]]; then
      eval "$controller_saved_hup_trap"
    else
      trap - HUP
    fi
  }

  controller_signal_child() {
    local signal="$1"

    if [[ "$controller_child_pid" =~ ^[1-9][0-9]*$ ]]; then
      kill "-$signal" -- "-$controller_child_pid" 2>/dev/null ||
        kill "-$signal" "$controller_child_pid" 2>/dev/null || true
    fi
    if [[ "$signal" == KILL &&
      "$controller_wrapper_pid" =~ ^[1-9][0-9]*$ ]]; then
      kill -KILL "$controller_wrapper_pid" 2>/dev/null || true
    fi
  }

  controller_record_signal() {
    local signal="$1"
    local status="$2"

    if [[ "$controller_signal_status" -eq 0 ]]; then
      controller_signal_status="$status"
    fi
    controller_signal_child "$signal"
  }

  controller_read_until() {
    local stop_second="$1"
    local controller_payload_length=""
    local controller_payload_record=""
    local controller_payload_value=""
    local controller_read_status=0
    local controller_wrapper_alive=false

    while [[ -z "$controller_child_status" &&
      "$SECONDS" -lt "$stop_second" ]]; do
      controller_wait_seconds=$(( stop_second - SECONDS ))
      if [[ "$controller_wait_seconds" -gt 1 ]]; then
        controller_wait_seconds=1
      fi
      controller_line=""
      if [[ "$controller_capture_mode" == true ]]; then
        controller_read_status=0
        if IFS= read -r -d '' -t "$controller_wait_seconds" \
          controller_line <&7; then
          if [[ "$controller_line" =~ $controller_pid_pattern ]]; then
            controller_child_pid="${BASH_REMATCH[1]}"
          elif [[ "$controller_line" =~ $controller_status_pattern ]]; then
            if [[ "$controller_capture_payload_seen" != true ]]; then
              return 125
            fi
            controller_child_status="${BASH_REMATCH[1]}"
          elif [[ "$controller_line" == "$controller_payload_prefix"* ]]; then
            controller_payload_record="${controller_line#"$controller_payload_prefix"}"
            if [[ "$controller_payload_record" != *:* ]]; then
              return 125
            fi
            controller_payload_length="${controller_payload_record%%:*}"
            controller_payload_value="${controller_payload_record#*:}"
            if [[ ! "$controller_payload_length" =~ ^[0-9]+$ ||
              "${#controller_payload_value}" -ne "$controller_payload_length" ]]; then
              return 125
            fi
            controller_capture_value="${controller_capture_value}${controller_payload_value}"
            controller_capture_payload_seen=true
          else
            return 125
          fi
        else
          controller_read_status=$?
          controller_wrapper_alive=false
          if [[ "$controller_wrapper_pid" =~ ^[1-9][0-9]*$ ]] &&
            kill -0 "$controller_wrapper_pid" 2>/dev/null; then
            controller_wrapper_alive=true
          fi
          if [[ -n "$controller_line" ||
            ( "$controller_read_status" -eq 1 &&
              "$controller_wrapper_alive" != true ) ]]; then
            return 125
          else
            controller_line=""
          fi
        fi
      elif IFS= read -r -t "$controller_wait_seconds" controller_line <&7; then
        case "$controller_line" in
          pid:[1-9][0-9]*) controller_child_pid="${controller_line#pid:}" ;;
          status:[0-9]*) controller_child_status="${controller_line#status:}" ;;
          *) return 125 ;;
        esac
      fi
      if [[ "$controller_signal_status" -ne 0 &&
        "$controller_capture_draining" != true ]]; then
        return 1
      fi
    done
    [[ -n "$controller_child_status" ]]
  }

  controller_saved_term_trap=$(trap -p TERM)
  controller_saved_int_trap=$(trap -p INT)
  controller_saved_hup_trap=$(trap -p HUP)
  trap 'controller_record_signal TERM 143' TERM
  trap 'controller_record_signal INT 130' INT
  trap 'controller_record_signal HUP 129' HUP

  exec 8>&1
  exec 9>&2
  exec 7< <(
    set +e
    set -m
    if [[ "$controller_capture_mode" == true ]]; then
      (
        broker_capture_value=""
        broker_command_status=0
        broker_signal_status=0
        broker_record_signal() {
          local status="$1"

          if [[ "$broker_signal_status" -eq 0 ]]; then
            broker_signal_status="$status"
          fi
          broker_command_status="$broker_signal_status"
        }
        trap 'broker_record_signal 143' TERM
        trap 'broker_record_signal 130' INT
        trap 'broker_record_signal 129' HUP
        broker_capture_value=$(
          trap - TERM INT HUP
          unset controller_capture_draining controller_capture_name \
            controller_capture_nonce controller_capture_payload_seen \
            controller_capture_value controller_payload_prefix \
            controller_pid_pattern controller_protocol_status \
            controller_read_result controller_status_pattern \
            controller_child_pid controller_child_status controller_line \
            broker_capture_value broker_command_status broker_signal_status
          unset -f broker_record_signal controller_read_until \
            controller_record_signal controller_restore_traps \
            controller_signal_child
          "$@"
        ) || broker_command_status=$?
        if [[ "$broker_signal_status" -ne 0 ]]; then
          broker_command_status="$broker_signal_status"
        fi
        printf '%s%s:%s\0' \
          "$controller_payload_prefix" "${#broker_capture_value}" \
          "$broker_capture_value"
        exit "$broker_command_status"
      ) 2>&9 &
    else
      ( "$@" ) >&8 2>&9 &
    fi
    controller_job_pid=$!
    if [[ "$controller_capture_mode" == true ]]; then
      printf '%s:pid:%s\0' "$controller_capture_nonce" "$controller_job_pid"
    else
      printf 'pid:%s\n' "$controller_job_pid"
    fi
    wait "$controller_job_pid"
    controller_job_status=$?
    if [[ "$controller_capture_mode" == true ]]; then
      printf '%s:status:%s\0' \
        "$controller_capture_nonce" "$controller_job_status"
    else
      printf 'status:%s\n' "$controller_job_status"
    fi
  )
  controller_wrapper_pid=$!

  controller_read_result=0
  controller_read_until "$term_second" || controller_read_result=$?
  if [[ "$controller_read_result" -ne 0 ]]; then
    if [[ "$controller_read_result" -eq 125 ]]; then
      controller_protocol_status=125
    fi
    if [[ "$controller_signal_status" -eq 0 ]]; then
      controller_timed_out=true
    fi
  fi
  if [[ -n "$controller_child_status" &&
    "$controller_child_pid" =~ ^[1-9][0-9]*$ ]] &&
    kill -0 -- "-$controller_child_pid" 2>/dev/null; then
    controller_residual_group=true
    controller_signal_child TERM
    controller_signal_child KILL
  fi
  if [[ -z "$controller_child_status" ]]; then
    controller_signal_child TERM
    if [[ "$controller_signal_status" -ne 0 &&
      "$kill_second" -gt $(( SECONDS + 1 )) ]]; then
      kill_second=$(( SECONDS + 1 ))
    fi
    controller_capture_draining="$controller_capture_mode"
    controller_read_result=0
    controller_read_until "$kill_second" || controller_read_result=$?
    if [[ "$controller_read_result" -eq 125 ]]; then
      controller_protocol_status=125
    fi
  fi
  if [[ -z "$controller_child_status" || "$SECONDS" -ge "$kill_second" ]]; then
    controller_timed_out=true
    controller_signal_child KILL
  fi

  wait "$controller_wrapper_pid" 2>/dev/null || true
  exec 7<&-
  exec 8>&-
  exec 9>&-
  controller_restore_traps

  if [[ "$controller_capture_mode" == true ]]; then
    printf -v "$controller_capture_name" '%s' "$controller_capture_value" ||
      return 125
  fi

  if [[ "$controller_signal_status" -ne 0 ]]; then
    return "$controller_signal_status"
  fi
  if [[ "$controller_protocol_status" -ne 0 ]]; then
    return "$controller_protocol_status"
  fi
  if [[ "$controller_timed_out" == true ]]; then
    return 124
  fi
  if [[ "$controller_residual_group" == true &&
    "$controller_child_status" -eq 0 ]]; then
    return 125
  fi
  if [[ ! "$controller_child_status" =~ ^[0-9]+$ ]]; then
    return 125
  fi
  return "$controller_child_status"
}

controller_deadline_cutoffs() {
  local term_output="${1:-}"
  local kill_output="${2:-}"
  local deadline_duration_ms=""
  local deadline_duration_seconds=0
  local controller_term_grace_seconds=1
  local computed_term_second=0
  local computed_kill_second=0

  if [[ ! "$term_output" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ||
    ! "$kill_output" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    return 64
  fi
  if [[ "${started_at_ms:-}" =~ ^[0-9]+$ &&
    "${launcher_deadline_at_ms:-}" =~ ^[0-9]+$ ]]; then
    deadline_duration_ms=$(( launcher_deadline_at_ms - started_at_ms ))
  elif [[ "${launcher_deadline_ms:-}" =~ ^[0-9]+$ ]]; then
    deadline_duration_ms="$launcher_deadline_ms"
  else
    return 64
  fi
  if [[ "$deadline_duration_ms" -le 0 ]]; then
    return 124
  fi
  deadline_duration_seconds=$(( deadline_duration_ms / 1000 ))
  computed_kill_second=$(( controller_started_seconds + deadline_duration_seconds ))
  computed_term_second=$(( computed_kill_second - controller_term_grace_seconds ))
  if [[ "$computed_term_second" -lt 0 ||
    "$SECONDS" -ge "$computed_kill_second" ]]; then
    return 124
  fi
  printf -v "$term_output" '%s' "$computed_term_second"
  printf -v "$kill_output" '%s' "$computed_kill_second"
}

controller_capture_before_deadline() {
  local output_name="${1:-}"
  local capture_value=""
  local capture_status=0
  local term_second=""
  local kill_second=""

  if [[ ! "$output_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ || "$#" -lt 2 ]]; then
    return 64
  fi
  shift

  controller_deadline_cutoffs term_second kill_second || return $?
  controller_run_until "$term_second" "$kill_second" \
    --capture capture_value "$@" || capture_status=$?
  if [[ "$capture_status" -ne 0 ]]; then
    return "$capture_status"
  fi
  printf -v "$output_name" '%s' "$capture_value"
}

now_ms() {
  bun -e 'process.stdout.write(String(Date.now()))'
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

compute_latest_projection_sha256() {
  jq -cS '
    del(.ledgerSha256, .latestProjectionSha256, .terminalProof)
  ' "$1" | shasum -a 256 | awk '{print $1}'
}

select_terminal_monitor() {
  local monitor_directory="$1"
  local require_success="$2"
  local monitor_path=""
  local monitor_run_id=""
  local monitor_files=()

  while IFS= read -r -d '' monitor_path; do
    monitor_files+=("$monitor_path")
  done < <(find "$monitor_directory" -type f -name '*.json' -print0)
  if [[ "${#monitor_files[@]}" -eq 0 && "$require_success" == false ]]; then
    return 0
  fi
  if [[ "${#monitor_files[@]}" -ne 1 ]]; then
    echo "terminal monitor evidence requires exactly one JSON file" >&2
    return 65
  fi

  monitor_path="${monitor_files[0]}"
  monitor_run_id=$(basename "$monitor_path" .json) || return $?
  if [[ -z "$monitor_run_id" ]] || ! jq -e \
    --arg runId "$monitor_run_id" \
    --argjson requireSuccess "$require_success" '
      .runId == $runId
      and .backend == "codex"
      and (.stages | type == "array")
      and (.outcomes | type == "array")
      and (.failures | type == "array")
      and (.summary | type == "object")
      and (if $requireSuccess then
        (.outcomes | length == 1)
        and .outcomes[0].reason == "completed"
        and .outcomes[0].verdict == "clean"
        and (.failures | length == 0)
        and .summary.pass == 1
        and .summary.fail == 0
      else true end)
    ' "$monitor_path" >/dev/null;
  then
    echo "terminal monitor evidence is invalid: $monitor_path" >&2
    return 65
  fi
  printf '%s\n' "$monitor_path"
}

validate_terminal_report() {
  local terminal_report="$1"
  local terminal_monitor="$2"
  local worker_deadline_at_ms="$3"
  local monitor_run_id=""
  local pr_prefix="https://github.com/$repository/pull/"

  monitor_run_id=$(basename "$terminal_monitor" .json) || return $?
  if [[ -z "$monitor_run_id" ]]; then
    return 65
  fi
  jq -e --arg runId "$run_id" \
    --arg monitorRunId "$monitor_run_id" \
    --arg profile "$complexity" \
    --arg branch "$branch" \
    --arg worktree "$worktree" \
    --arg baseSha "$base_sha" \
    --arg artifactDigest "$artifact_digest" \
    --arg repository "$repository" \
    --arg prUrl "$pr_url" \
    --arg prPrefix "$pr_prefix" \
    --argjson startedAtMs "$started_at_ms" \
    --argjson deadlineMs "$launcher_deadline_ms" \
    --argjson workerDeadlineAtMs "$worker_deadline_at_ms" '
      def nonnegative_integer:
        type == "number" and . >= 0 and floor == .;
      def recorded_command:
        type == "object"
        and (.status == "passed" or .status == "failed")
        and (.command | (type == "string" and length > 0))
        and (.stdout | type == "string")
        and (.stderr | type == "string")
        and (.exitCode | (
          . == null or (type == "number" and floor == .)
        ))
        and (.durationMs | nonnegative_integer);
      def passed_command:
        recorded_command
        and .status == "passed"
        and .exitCode == 0;
      . as $report
      | ("gh pr checks \($report.prUrl) --json name,workflow,bucket")
        as $remoteChecksCommand
      | ("gh pr merge \($report.prUrl) --squash --match-head-commit \($report.matchedHeadSha)")
        as $mergeRequestCommand
      | ("gh pr view \($report.prUrl) --json url,baseRefName,headRefName,headRefOid,isDraft,state")
        as $mergeConfirmationCommand
      | .runId == $runId
      and .monitorRunId == $monitorRunId
      and .profile == $profile
      and .branch == $branch
      and .worktree == $worktree
      and .baseSha == $baseSha
      and .artifactDigest == $artifactDigest
      and .repository == $repository
      and .backend == "codex"
      and (.stage | (type == "string" and length > 0))
      and .startedAtMs == $startedAtMs
      and .workerDeadlineAtMs == $workerDeadlineAtMs
      and (.finishedAtMs | nonnegative_integer)
      and .finishedAtMs <= $workerDeadlineAtMs
      and (.elapsedMs | nonnegative_integer)
      and .elapsedMs == (.finishedAtMs - .startedAtMs)
      and .elapsedMs <= $deadlineMs
      and .merged == true
      and .sla == "passed"
      and .stopReason == "completed"
      and .prUrl == $prUrl
      and (.prUrl | (
        type == "string"
        and startswith($prPrefix)
        and (ltrimstr($prPrefix) | test("^[1-9][0-9]*$"))
      ))
      and (.matchedHeadSha | (
        type == "string" and test("^[0-9a-f]{40}$")
      ))
      and (.usage | type == "object")
      and (.usage.input | nonnegative_integer)
      and (.usage.output | nonnegative_integer)
      and (.usage | if has("reasoning") then
        (.reasoning | nonnegative_integer)
      else true end)
      and ((.usage.input + .usage.output + (.usage.reasoning // 0)) > 0)
      and ($report.validation | if type == "array" then
        any(.[];
          passed_command and .command == $remoteChecksCommand
        )
        and any(.[];
          recorded_command and .command == $mergeRequestCommand
        )
        and any(.[];
          passed_command and .command == $mergeConfirmationCommand
        )
      else false end)
      and (.remoteChecks | type == "object")
      and .remoteChecks.state == "passed"
      and (.remoteChecks.checkedAt | (
        type == "string" and length > 0
      ))
      and .remoteChecks.headSha == .matchedHeadSha
      and (.remoteChecks.command | passed_command)
      and .remoteChecks.command.command == $remoteChecksCommand
      and (.remoteChecks.checks | (
        type == "array"
        and length > 0
        and all(.[]; .bucket == "pass")
        and any(.[];
          .name == "Verify"
          and .workflow == "CI"
          and .bucket == "pass"
        )
      ))
      and (.mergeProof | type == "object")
      and (.mergeProof.checkedAt | (
        type == "string" and length > 0
      ))
      and .mergeProof.url == .prUrl
      and .mergeProof.baseRefName == "main"
      and .mergeProof.headRefName == $branch
      and .mergeProof.headRefOid == .matchedHeadSha
      and .mergeProof.isDraft == false
      and .mergeProof.state == "MERGED"
      and (.mergeProof.command | passed_command)
      and .mergeProof.command.command == $mergeConfirmationCommand
    ' "$terminal_report" >/dev/null
}

compute_terminal_ledger_proof() {
  printf '%s\n' "$1" "$2" "$3" "$4" "$5" "$6" | \
    shasum -a 256 | awk '{print $1}'
}

create_terminal_ledger_stage() {
  local canonical="${1:-}"
  local canonical_parent="${canonical%/*}"

  if [[ -z "$canonical" || "$canonical_parent" == "$canonical" ]]; then
    return 65
  fi
  (
    umask 077
    mktemp "$canonical_parent/.issues.jsonl.terminal.XXXXXX"
  )
}

validate_terminal_ledger_publication_paths() {
  local stage="${1:-}"
  local canonical="${2:-}"
  local stage_parent="${stage%/*}"
  local canonical_parent="${canonical%/*}"

  if [[ -z "$stage" || -z "$canonical" || "$stage" == "$canonical" || \
    "$stage_parent" == "$stage" || "$canonical_parent" == "$canonical" || \
    "$stage_parent" != "$canonical_parent" || ! -f "$stage" || -L "$stage" || \
    ! -f "$canonical" || -L "$canonical" ]]; then
    echo "terminal issue ledger publication path is unsafe" >&2
    return 65
  fi
}

run_id=""
branch=""
worktree=""
run_dir=""
latest=""
latest_quarantine=""
launcher_log=""
ledger=""
ledger_lock=""
ledger_base_snapshot=""
preflight_path=""
preflight_quarantine=""
protected_package_lock=""
started_at_ms=""
launcher_deadline_ms=600000
launcher_finalization_reserve_ms=10000
canonical_recovery_reserve_ms=1000
launcher_absolute_deadline_at_ms=0
launcher_work_deadline_at_ms=0
launcher_deadline_at_ms=0
monitor_path=""
report_path=""
pr_url=""
elapsed_ms=0
runtime_path=""
runtime_head=""
runtime_sha256=""
runtime_version=""
base_sha=""
artifact_digest=""
origin_fetch_url=""
origin_push_url=""
repository=""
preflight_artifact_digest=""
preflight_base_sha=""
preflight_worker_exit_code=""
preflight_worker_completed_at_ms=""
preflight_validity_ms=600000
launcher_signal_status=0
package_lock_existed_before=false
package_lock_sha256_before=""
package_lock_sha256_after=""

locked_artifacts=(
  ".orca/improvement-loop/issues.jsonl"
  ".orca/workflows/codebase-improvement-artifacts.test.ts"
  ".orca/workflows/codebase-improvement-contract.test.ts"
  ".orca/workflows/codebase-improvement-lib.test.ts"
  ".orca/workflows/codebase-improvement-lib.ts"
  ".orca/workflows/codebase-improvement-runtime.test.ts"
  ".orca/workflows/codebase-improvement-runtime.ts"
  ".orca/workflows/codebase-improvement.config.json"
  ".orca/workflows/codebase-improvement.run.md"
  ".orca/workflows/codebase-improvement.sh"
  ".orca/workflows/codebase-improvement.ts"
  "docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md"
  "docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md"
  "docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md"
)

validate_issue_ledger() {
  local ledger_path="$1"
  local expected_seed='{"id":"feature-implementation-timeout","runId":"b22d31ec-f985-49d0-92b9-c3bd03c612e8","at":"2026-07-10T00:00:00.000Z","classification":"backend","stage":"implement","elapsedMs":600008,"evidence":"Feature implementation exceeded the prior 600000ms backend turn; corrective design path: isolate current origin/main, split work into bounded scout, reproduce, implement, repair, and review stages, preserve centralized evidence, and retain the failed branch and worktree.","status":"open"}'
  local first_line=""
  local line=""
  local line_number=0

  if [[ ! -f "$ledger_path" ]]; then
    echo "invalid issue ledger: missing $ledger_path" >&2
    return 65
  fi
  if [[ ! -s "$ledger_path" ]]; then
    echo "invalid issue ledger: empty $ledger_path" >&2
    return 65
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    line_number=$(( line_number + 1 ))
    if [[ "$line_number" -eq 1 ]]; then
      first_line="$line"
    fi
    if ! printf '%s\n' "$line" | jq -e -s '
      length == 1
      and (.[0] | type == "object")
      and (.[0].id | type == "string" and test("\\S"))
      and (.[0].runId | type == "string" and test("\\S"))
      and (.[0].at | type == "string" and test("\\S"))
      and (.[0].classification | type == "string" and test("\\S"))
      and (.[0].stage | type == "string" and test("\\S"))
      and (.[0].elapsedMs | type == "number" and . >= 0)
      and (.[0].evidence | type == "string" and test("\\S"))
      and (.[0].status == "open"
        or .[0].status == "corrected"
        or .[0].status == "resolved")
      and (((.[0] | has("backend")) | not)
        or (.[0].backend | type == "string"))
      and (((.[0] | has("worktree")) | not)
        or (.[0].worktree | type == "string"))
      and (((.[0] | has("branch")) | not)
        or (.[0].branch | type == "string"))
      and (((.[0] | has("monitorPath")) | not)
        or (.[0].monitorPath | type == "string"))
      and (((.[0] | has("prUrl")) | not)
        or (.[0].prUrl | type == "string"))
    ' >/dev/null 2>&1
    then
      echo "invalid issue ledger: line $line_number fails row schema" >&2
      return 65
    fi
  done < "$ledger_path"

  if [[ "$line_number" -eq 0 ]]; then
    echo "invalid issue ledger: empty $ledger_path" >&2
    return 65
  fi
  if [[ "$first_line" != "$expected_seed" ]]; then
    echo "invalid issue ledger: first seed record changed" >&2
    return 65
  fi
}

issue_ledger_has_no_latest_open() {
  local ledger_path="$1"

  jq -s -e '
    reduce .[] as $issue ({}; .[$issue.id] = $issue)
    | all(.[]; .status != "open")
  ' "$ledger_path" >/dev/null
}

issue_ledger_has_terminal_commit() {
  local ledger_path="$1"
  local commit_id="$2"
  local report_sha256="$3"
  local monitor_sha256="$4"
  local candidate_sha256="$5"
  local latest_projection_sha256="$6"

  jq -s -e --arg commitId "$commit_id" \
    --arg reportSha256 "$report_sha256" \
    --arg monitorSha256 "$monitor_sha256" \
    --arg candidateSha256 "$candidate_sha256" \
    --arg latestProjectionSha256 "$latest_projection_sha256" '
      [
        .[]
        | select(
            .terminalCommit == true and
            .terminalCommitId == $commitId and
            .reportSha256 == $reportSha256 and
            .monitorSha256 == $monitorSha256 and
            .candidateLedgerSha256 == $candidateSha256 and
            .latestProjectionSha256 == $latestProjectionSha256
          )
      ]
      | length == 1
    ' "$ledger_path" >/dev/null
}

validate_terminal_ledger_recovery() {
  local ledger_path="$1"
  local expected_sha256="$2"
  local commit_id="$3"
  local report_sha256="$4"
  local monitor_sha256="$5"
  local candidate_sha256="$6"
  local latest_projection_sha256="$7"
  local current_sha256=""

  [[ -f "$ledger_path" && ! -L "$ledger_path" ]] || return 1
  issue_ledger_has_terminal_commit \
    "$ledger_path" "$commit_id" "$report_sha256" "$monitor_sha256" \
    "$candidate_sha256" "$latest_projection_sha256" || return $?
  current_sha256=$(sha256_file "$ledger_path") || return $?
  [[ "$current_sha256" == "$expected_sha256" ]]
}

compute_artifact_digest() {
  local root="$1"
  local artifact_path=""
  local path=""
  local sha=""
  local manifest=""

  manifest=$(mktemp "${TMPDIR:-/tmp}/orcats-artifacts.XXXXXX")
  for path in "${locked_artifacts[@]}"; do
    artifact_path="$root/$path"
    if [[ "$root" == "$source_root" && \
      "$path" == ".orca/improvement-loop/issues.jsonl" && \
      -n "${ledger_base_snapshot:-}" ]]; then
      artifact_path="$ledger_base_snapshot"
    fi
    if [[ ! -f "$artifact_path" ]]; then
      rm -f "$manifest"
      echo "missing locked artifact: $path" >&2
      return 66
    fi
    sha=$(sha256_file "$artifact_path")
    printf '%s  %s\n' "$sha" "$path" >> "$manifest"
  done
  sha256_file "$manifest"
  rm -f "$manifest"
}

copy_locked_artifacts() {
  local path=""

  for path in "${locked_artifacts[@]}"; do
    if [[ "$mode" == live && "$path" == docs/* ]]; then
      continue
    fi
    mkdir -p "$worktree/$(dirname "$path")"
    if [[ "$path" == ".orca/improvement-loop/issues.jsonl" && \
      -n "${ledger_base_snapshot:-}" ]]; then
      cp -p "$ledger_base_snapshot" "$worktree/$path"
    else
      cp -p "$source_root/$path" "$worktree/$path"
    fi
  done
}

verify_locked_artifact_copy() {
  local current_digest=""
  local path=""
  local source_sha=""
  local worktree_sha=""

  current_digest=$(compute_artifact_digest "$source_root") || return $?
  if [[ "$current_digest" != "$artifact_digest" ]]; then
    echo "locked artifacts changed after digest capture" >&2
    return 66
  fi
  for path in "${locked_artifacts[@]}"; do
    if [[ "$mode" == live && "$path" == docs/* ]]; then
      if [[ -e "$worktree/$path" ]]; then
        echo "live worktree contains locked documentation: $path" >&2
        return 66
      fi
      continue
    fi
    if [[ ! -f "$worktree/$path" ]]; then
      echo "copied locked artifact is missing: $path" >&2
      return 66
    fi
    if [[ "$path" == ".orca/improvement-loop/issues.jsonl" && \
      -n "${ledger_base_snapshot:-}" ]]; then
      source_sha=$(sha256_file "$ledger_base_snapshot") || return $?
    else
      source_sha=$(sha256_file "$source_root/$path") || return $?
    fi
    worktree_sha=$(sha256_file "$worktree/$path") || return $?
    if [[ "$source_sha" != "$worktree_sha" ]]; then
      echo "copied locked artifact differs: $path" >&2
      return 66
    fi
  done
}

snapshot_package_lock() {
  if [[ -f "$protected_package_lock" ]]; then
    package_lock_existed_before=true
    capture_before_deadline package_lock_sha256_before sha256_file \
      "$protected_package_lock" || return $?
  elif [[ -e "$protected_package_lock" ]]; then
    echo "protected package-lock is not a regular file: $protected_package_lock" >&2
    return 66
  fi
}

remaining_launcher_ms() {
  local output_name="${1:-}"
  local clock_mode="${2:-exact}"
  local current_ms=""
  local elapsed_seconds=0
  local computed_ms=0

  if [[ ! "$output_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    return 64
  fi
  case "$clock_mode" in
    exact)
      if [[ ! "$launcher_deadline_at_ms" =~ ^[0-9]+$ ]]; then
        return 64
      fi
      controller_capture_before_deadline current_ms now_ms || return $?
      if [[ ! "$current_ms" =~ ^[0-9]+$ ]]; then
        return 64
      fi
      computed_ms=$(( launcher_deadline_at_ms - current_ms ))
      ;;
    poll)
      if [[ ! "${command_deadline_started_seconds:-}" =~ ^[0-9]+$ ||
        ! "${command_initial_remaining_ms:-}" =~ ^[0-9]+$ ]]; then
        return 64
      fi
      elapsed_seconds=$(( SECONDS - command_deadline_started_seconds ))
      computed_ms=$(( command_initial_remaining_ms - (elapsed_seconds * 1000) ))
      ;;
    *) return 64 ;;
  esac
  printf -v "$output_name" '%s' "$computed_ms"
}

run_before_deadline() {
  local remaining_ms=""
  local command_status=0
  local command_owner_token=""
  local command_parent_pid="$$"
  local command_deadline_started_seconds="$SECONDS"
  local command_initial_remaining_ms=""
  local command_active_term_second=""
  local command_active_kill_second=""
  local controller_term_grace_seconds=1
  local command_cleanup_reserve_seconds=2
  local command_term_second=""
  local command_kill_second=""
  local owner_scan_status=0
  local owner_cleanup_status=0
  local pending_terminal_signal_status="${terminal_commit_signal_status:-0}"
  local command_capture_mode=false
  local command_capture_name=""
  local command_capture_value=""

  if [[ "$pending_terminal_signal_status" -ne 0 ]]; then
    return "$pending_terminal_signal_status"
  fi
  if [[ "${1:-}" == --capture ]]; then
    if [[ "$#" -lt 3 ||
      ! "${2:-}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      return 64
    fi
    command_capture_mode=true
    command_capture_name="$2"
    shift 2
  fi
  if [[ "$#" -eq 0 ]]; then
    return 64
  fi
  remaining_launcher_ms remaining_ms || return 124
  if [[ "$remaining_ms" -le 0 ]]; then
    return 124
  fi
  command_initial_remaining_ms="$remaining_ms"
  controller_deadline_cutoffs command_term_second command_kill_second ||
    return $?
  command_active_kill_second=$(( command_kill_second - command_cleanup_reserve_seconds ))
  command_active_term_second=$((
    command_active_kill_second - controller_term_grace_seconds
  ))
  if [[ "$command_active_term_second" -lt 0 ||
    "$SECONDS" -ge "$command_active_kill_second" ]]; then
    return 124
  fi
  command_owner_token="$RANDOM$RANDOM$RANDOM$RANDOM$RANDOM$RANDOM"

  scan_and_signal_command_owners() {
    local owner_signal="${1:-NONE}"
    local owner_pid=""

    if [[ "$owner_signal" != NONE &&
      "$owner_signal" != TERM &&
      "$owner_signal" != KILL ]]; then
      return 125
    fi
    set -o pipefail
    ps eww -U "$UID" -x -o pid=,command= |
      awk \
        -v owner_parent_pid="$command_parent_pid" \
        -v owner_token="ORCA_IMPROVEMENT_COMMAND_OWNER=$command_owner_token" '
          $1 ~ /^[0-9]+$/ && $1 != owner_parent_pid {
            for (field = 2; field <= NF; field += 1) {
              if ($field == owner_token) {
                print $1
                next
              }
            }
          }
        ' |
      {
        owner_found=false
        while IFS= read -r owner_pid || [[ -n "$owner_pid" ]]; do
          if [[ ! "$owner_pid" =~ ^[1-9][0-9]*$ ]]; then
            exit 125
          fi
          owner_found=true
          if [[ "$owner_signal" != NONE ]]; then
            kill "-$owner_signal" "$owner_pid" 2>/dev/null || true
          fi
        done
        if [[ "$owner_found" == true ]]; then
          exit 42
        fi
      }
  }

  terminate_command_owner_pids() {
    owner_scan_status=0
    controller_run_until "$command_term_second" "$command_kill_second" \
      scan_and_signal_command_owners TERM || owner_scan_status=$?
    case "$owner_scan_status" in
      0) return 0 ;;
      42) ;;
      124|143|130|129) return "$owner_scan_status" ;;
      *) return 125 ;;
    esac

    owner_scan_status=0
    controller_run_until "$command_term_second" "$command_kill_second" \
      scan_and_signal_command_owners KILL || owner_scan_status=$?
    case "$owner_scan_status" in
      0|42) ;;
      124|143|130|129) return "$owner_scan_status" ;;
      *) return 125 ;;
    esac

    owner_scan_status=0
    controller_run_until "$command_term_second" "$command_kill_second" \
      scan_and_signal_command_owners NONE || owner_scan_status=$?
    case "$owner_scan_status" in
      0) return 0 ;;
      42) return 125 ;;
      124|143|130|129) return "$owner_scan_status" ;;
      *) return 125 ;;
    esac
  }

  cleanup_owned_processes_inline() {
    scan_and_signal_command_owners TERM 2>/dev/null || owner_scan_status=$?
    if [[ "$owner_scan_status" -eq 42 ]]; then
      scan_and_signal_command_owners KILL 2>/dev/null || true
    fi
  }

  run_owned_command() {
    trap 'cleanup_owned_processes_inline; exit 143' TERM
    trap 'cleanup_owned_processes_inline; exit 130' INT
    trap 'cleanup_owned_processes_inline; exit 129' HUP
    ORCA_IMPROVEMENT_COMMAND_OWNER="$command_owner_token" "$@"
  }

  if [[ "$command_capture_mode" == true ]]; then
    controller_run_until "$command_active_term_second" \
      "$command_active_kill_second" \
      --capture command_capture_value run_owned_command "$@" || command_status=$?
    if ! printf -v "$command_capture_name" '%s' "$command_capture_value" &&
      [[ "$command_status" -eq 0 ]]; then
      command_status=125
    fi
  else
    controller_run_until "$command_active_term_second" \
      "$command_active_kill_second" \
      run_owned_command "$@" || command_status=$?
  fi
  owner_cleanup_status=0
  terminate_command_owner_pids || owner_cleanup_status=$?
  if [[ "$owner_cleanup_status" -ne 0 ]]; then
    case "$owner_cleanup_status" in
      143|130|129)
        if [[ "$launcher_signal_status" -eq 0 ]]; then
          launcher_signal_status="$owner_cleanup_status"
        fi
        ;;
    esac
    return "$owner_cleanup_status"
  fi
  case "$command_status" in
    143|130|129)
      if [[ "$launcher_signal_status" -eq 0 ]]; then
        launcher_signal_status="$command_status"
      fi
      ;;
  esac
  if [[ "$command_status" -eq 0 ]]; then
    remaining_launcher_ms remaining_ms || return 124
    if [[ "$remaining_ms" -le 0 ]]; then
      return 124
    fi
  fi
  return "$command_status"
}

run_before_deadline_with_reserve() {
  local reserve_ms="${1:-}"
  local outer_deadline_at_ms="$launcher_deadline_at_ms"
  local outer_remaining_ms=""
  local command_status=0
  local controller_term_grace_seconds=1
  local command_cleanup_reserve_seconds=2
  local outer_controller_reserve_ms=0
  local total_reserve_ms=0

  if [[ ! "$reserve_ms" =~ ^[1-9][0-9]*$ ]]; then
    return 64
  fi
  shift
  if [[ "$#" -eq 0 ]]; then
    return 64
  fi
  outer_controller_reserve_ms=$((
    (controller_term_grace_seconds + command_cleanup_reserve_seconds) * 1000
  ))
  total_reserve_ms=$(( reserve_ms + outer_controller_reserve_ms ))
  remaining_launcher_ms outer_remaining_ms || return 124
  if [[ "$outer_remaining_ms" -le "$total_reserve_ms" ]]; then
    return 124
  fi

  launcher_deadline_at_ms=$(( outer_deadline_at_ms - total_reserve_ms ))
  run_before_deadline "$@" || command_status=$?
  launcher_deadline_at_ms="$outer_deadline_at_ms"
  return "$command_status"
}

capture_command_output() {
  local output_path="$1"
  shift
  "$@" > "$output_path"
}

capture_before_deadline() {
  local output_name="${1:-}"
  local capture_status=0
  local capture_value=""

  if [[ "$#" -lt 2 || \
    ! "$output_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    return 64
  fi
  shift

  run_before_deadline --capture capture_value "$@" || capture_status=$?
  while [[ "$capture_value" == *$'\n' ]]; do
    capture_value="${capture_value%$'\n'}"
  done
  if ! printf -v "$output_name" '%s' "$capture_value" && \
    [[ "$capture_status" -eq 0 ]]; then
    capture_status=125
  fi
  return "$capture_status"
}

validate_regular_publication_file() {
  local path="$1"

  [[ -f "$path" && ! -L "$path" ]]
}

validate_latest_publication_file() {
  local path="$1"
  local expected_run_id="$2"
  local expected_exit_code="$3"

  [[ -f "$path" && ! -L "$path" ]] || return 65
  jq -e --arg runId "$expected_run_id" \
    --argjson exitCode "$expected_exit_code" '
      type == "object" and
      .runId == $runId and
      (.exitCode | type == "number") and
      .exitCode == $exitCode
    ' "$path" >/dev/null
}

validate_preflight_publication_file() {
  local path="$1"
  local expected_run_id="$2"

  [[ -f "$path" && ! -L "$path" ]] || return 65
  jq -e --arg runId "$expected_run_id" '
    type == "object" and
    .runId == $runId and
    .status == "succeeded" and
    .exitCode == 0
  ' "$path" >/dev/null
}

validate_failure_tombstone_file() {
  local path="$1"
  local expected_run_id="$2"
  local expected_exit_code="$3"

  [[ -f "$path" && ! -L "$path" ]] || return 65
  jq -e --arg runId "$expected_run_id" \
    --argjson exitCode "$expected_exit_code" '
      type == "object" and
      (keys | sort) == ["exitCode", "runId", "status"] and
      .runId == $runId and
      .status == "failed" and
      .exitCode == $exitCode
    ' "$path" >/dev/null
}

atomic_rename_action() {
  local source_path="$1"
  local destination_path="$2"
  local expected_sha256="$3"
  local validator="$4"
  local current_sha256=""
  local remaining_ms=""
  local publication_lock="${destination_path}.publication-lock"
  local publication_owner_name="owner.$RANDOM.$RANDOM"
  local publication_owner_marker="$publication_lock/$publication_owner_name"
  local publication_lock_owned=false
  local publication_owner_created=false
  local move_status=0
  shift 4

  publication_release_lock() {
    local caller_status="$1"
    local cleanup_owner_created="$publication_owner_created"
    local cleanup_lock_owned="$publication_lock_owned"
    local cleanup_status=0

    publication_owner_created=false
    publication_lock_owned=false
    if [[ "$cleanup_owner_created" == true && \
      -f "$publication_owner_marker" && \
      ! -L "$publication_owner_marker" ]]; then
      rm -f -- "$publication_owner_marker" || cleanup_status=$?
    fi
    if [[ "$cleanup_lock_owned" == true ]]; then
      rmdir -- "$publication_lock" 2>/dev/null || cleanup_status=$?
    fi
    return "$caller_status"
  }

  publication_handle_exit() {
    local exit_status="$?"

    trap - EXIT TERM INT HUP
    publication_release_lock "$exit_status" || :
    exit "$exit_status"
  }

  publication_handle_signal() {
    local signal_status="$1"

    trap - EXIT TERM INT HUP
    publication_release_lock "$signal_status" || :
    exit "$signal_status"
  }

  if ! mkdir "$publication_lock" 2>/dev/null; then
    return 73
  fi
  publication_lock_owned=true
  if ! ( set -o noclobber; : > "$publication_owner_marker" ) 2>/dev/null; then
    publication_release_lock 74 || :
    return 74
  fi
  publication_owner_created=true
  if [[ ! -f "$publication_owner_marker" || -L "$publication_owner_marker" ]]; then
    publication_release_lock 74 || :
    return 74
  fi
  trap 'publication_handle_exit' EXIT
  trap 'publication_handle_signal 143' TERM
  trap 'publication_handle_signal 130' INT
  trap 'publication_handle_signal 129' HUP

  if [[ ! -f "$source_path" || -L "$source_path" ]]; then
    move_status=66
  elif [[ -e "$destination_path" || -L "$destination_path" ]]; then
    move_status=73
  fi
  if [[ "$move_status" -eq 0 ]]; then
    "$validator" "$source_path" "$@" || move_status=$?
  fi
  if [[ "$move_status" -eq 0 ]]; then
    current_sha256=$(sha256_file "$source_path") || move_status=$?
  fi
  if [[ "$move_status" -eq 0 && \
    "$current_sha256" != "$expected_sha256" ]]; then
    move_status=65
  fi
  if [[ "$move_status" -eq 0 && \
    ( -e "$destination_path" || -L "$destination_path" ) ]]; then
    move_status=73
  fi
  if [[ "$move_status" -eq 0 ]]; then
    remaining_launcher_ms remaining_ms || move_status=124
  fi
  if [[ "$move_status" -eq 0 && "$remaining_ms" -le 0 ]]; then
    move_status=124
  fi
  if [[ "$move_status" -eq 0 ]]; then
    mv -- "$source_path" "$destination_path" || move_status=$?
  fi
  publication_release_lock "$move_status" || :
  trap - EXIT TERM INT HUP
  return "$move_status"
}

validate_atomic_rename_recovery() {
  local source_path="$1"
  local destination_path="$2"
  local expected_sha256="$3"
  local validator="$4"
  local current_sha256=""
  shift 4

  if [[ -e "$source_path" || -L "$source_path" ]]; then
    return 1
  fi
  if [[ ! -f "$destination_path" || -L "$destination_path" ]]; then
    return 1
  fi
  current_sha256=$(sha256_file "$destination_path") || return $?
  if [[ "$current_sha256" != "$expected_sha256" ]]; then
    return 1
  fi
  "$validator" "$destination_path" "$@"
}

atomic_rename_before_deadline() {
  local source_path="$1"
  local destination_path="$2"
  local validator="$3"
  local outer_deadline_at_ms="$launcher_deadline_at_ms"
  local expected_sha256=""
  local recovery_status=0
  local rename_status=0
  shift 3

  if [[ ! -f "$source_path" || -L "$source_path" ]]; then
    return 66
  fi
  if [[ -e "$destination_path" || -L "$destination_path" ]]; then
    return 73
  fi
  capture_before_deadline expected_sha256 sha256_file "$source_path" || \
    return $?
  run_before_deadline_with_reserve "$canonical_recovery_reserve_ms" \
    atomic_rename_action "$source_path" "$destination_path" \
    "$expected_sha256" "$validator" "$@" || rename_status=$?
  launcher_deadline_at_ms="$outer_deadline_at_ms"
  if [[ "$rename_status" -eq 0 ]]; then
    return 0
  fi
  if [[ "${launcher_signal_status:-0}" -ne 0 || \
    "${terminal_commit_signal_status:-0}" -ne 0 ]]; then
    return "$rename_status"
  fi
  if [[ "$rename_status" -ne 124 ]]; then
    return "$rename_status"
  fi
  run_before_deadline validate_atomic_rename_recovery \
    "$source_path" "$destination_path" "$expected_sha256" \
    "$validator" "$@" || recovery_status=$?
  if [[ "${launcher_signal_status:-0}" -ne 0 ]]; then
    return "$launcher_signal_status"
  fi
  if [[ "${terminal_commit_signal_status:-0}" -ne 0 ]]; then
    return "$terminal_commit_signal_status"
  fi
  if [[ "$recovery_status" -eq 0 ]]; then
    return 0
  fi
  return "$rename_status"
}

discard_private_path_before_deadline() {
  local path="$1"
  local remaining_ms=""

  if [[ ! -e "$path" && ! -L "$path" ]]; then
    return 0
  fi
  remaining_launcher_ms remaining_ms || return 0
  if [[ "$remaining_ms" -le 0 ]]; then
    return 0
  fi
  run_before_deadline rm -f -- "$path"
}

discard_private_directory_before_deadline() {
  local path="$1"
  local remaining_ms=""

  if [[ ! -e "$path" && ! -L "$path" ]]; then
    return 0
  fi
  remaining_launcher_ms remaining_ms || return 0
  if [[ "$remaining_ms" -le 0 ]]; then
    return 0
  fi
  run_before_deadline rmdir -- "$path"
}

quarantine_prior_evidence() {
  local stable_path=""
  local quarantine_path=""
  local fallback_path=""
  local quarantine_status=0
  local rename_status=0
  local stable_paths=("$latest")
  local quarantine_paths=("$latest_quarantine")
  local fallback_paths=("${2:-}")
  local index=0

  if [[ "$mode" == preflight ]]; then
    stable_paths=("$preflight_path" "$latest")
    quarantine_paths=("$preflight_quarantine" "$latest_quarantine")
    fallback_paths=("${1:-}" "${2:-}")
  fi
  for index in "${!stable_paths[@]}"; do
    stable_path="${stable_paths[$index]}"
    quarantine_path="${quarantine_paths[$index]}"
    fallback_path="${fallback_paths[$index]}"
    if [[ ! -e "$stable_path" && ! -L "$stable_path" ]]; then
      continue
    fi
    if [[ -e "$quarantine_path" || -L "$quarantine_path" ]]; then
      if [[ -z "$fallback_path" || -e "$fallback_path" || \
        -L "$fallback_path" ]]; then
        echo "prior evidence quarantine already exists: $quarantine_path" >&2
        quarantine_status=1
        continue
      fi
      quarantine_path="$fallback_path"
    fi
    rename_status=0
    atomic_rename_before_deadline \
      "$stable_path" "$quarantine_path" validate_regular_publication_file || \
      rename_status=$?
    if [[ "$rename_status" -ne 0 ]]; then
      if [[ "${launcher_signal_status:-0}" -ne 0 ]]; then
        return "$launcher_signal_status"
      fi
      echo "failed to quarantine prior evidence: $stable_path" >&2
      quarantine_status=1
    fi
  done
  return "$quarantine_status"
}

assert_package_lock_unchanged() {
  package_lock_sha256_after=""
  if [[ "$package_lock_existed_before" == true ]]; then
    if [[ ! -f "$protected_package_lock" ]]; then
      echo "protected package-lock disappeared: $protected_package_lock" >&2
      return 1
    fi
    capture_before_deadline package_lock_sha256_after sha256_file \
      "$protected_package_lock" || return 1
    if [[ "$package_lock_sha256_after" != "$package_lock_sha256_before" ]]; then
      echo "protected package-lock changed: $protected_package_lock" >&2
      return 1
    fi
  elif [[ -e "$protected_package_lock" ]]; then
    echo "protected package-lock appeared: $protected_package_lock" >&2
    return 1
  fi
}

merge_issue_ledger() {
  local candidate_ledger="$1"
  local base_ledger="$2"
  local merge_mode="${3:-normal}"
  local merge_token="$$.$RANDOM"
  local ledger_merge_tmp="${ledger}.merge.$merge_token"
  local source_suffix_tmp="${ledger}.source-suffix.$merge_token"
  local candidate_suffix_tmp="${ledger}.candidate-suffix.$merge_token"
  local source_ids_tmp="${ledger}.source-ids.$merge_token"
  local candidate_ids_tmp="${ledger}.candidate-ids.$merge_token"
  local overlap_ids_tmp="${ledger}.overlap-ids.$merge_token"
  local filtered_candidate_tmp="${ledger}.candidate-filtered.$merge_token"
  local resolved_rows_tmp="${ledger}.resolved-rows.$merge_token"
  local terminal_record_tmp="${ledger}.terminal-record.$merge_token"
  local ledger_lock_owner_name="owner.$$.$RANDOM"
  local ledger_lock_owner_marker="$ledger_lock/$ledger_lock_owner_name"
  local base_bytes=""
  local conflict_id=""
  local lock_acquired=false
  local owner_marker_created=false
  local remaining_ms=""
  local inspected_lock_state=""
  local inspected_owner_marker=""
  local inspected_owner_pid=""
  local current_candidate_sha256=""
  local current_latest_ledger_claim=""
  local current_latest_projection_claim=""
  local current_latest_projection_sha256=""
  local current_latest_terminal_proof_claim=""
  local current_monitor_sha256=""
  local current_report_sha256=""
  local current_terminal_ledger_sha256=""

  if [[ "$merge_mode" != normal && "$merge_mode" != failure && \
    "$merge_mode" != terminal && "$merge_mode" != terminal-stage && \
    "$merge_mode" != terminal-commit ]]; then
    echo "invalid issue ledger merge mode: $merge_mode" >&2
    return 64
  fi

  inspect_ledger_lock() {
    local entry=""
    local entry_name=""
    local -a entries=()

    inspected_lock_state="missing"
    inspected_owner_marker=""
    inspected_owner_pid=""
    if [[ -L "$ledger_lock" ]]; then
      inspected_lock_state="invalid"
      return 0
    fi
    if [[ ! -d "$ledger_lock" ]]; then
      return 0
    fi
    for entry in "$ledger_lock"/* "$ledger_lock"/.[!.]* \
      "$ledger_lock"/..?*; do
      if [[ -e "$entry" || -L "$entry" ]]; then
        entries+=("$entry")
      fi
    done
    if [[ "${#entries[@]}" -eq 0 ]]; then
      inspected_lock_state="empty"
      return 0
    fi
    if [[ "${#entries[@]}" -ne 1 ]]; then
      inspected_lock_state="invalid"
      return 0
    fi
    entry="${entries[0]}"
    entry_name="${entry##*/}"
    if [[ ! -f "$entry" || -L "$entry" || \
      ! "$entry_name" =~ ^owner\.([1-9][0-9]*)\.([0-9]+)$ ]]; then
      inspected_lock_state="invalid"
      return 0
    fi
    inspected_owner_marker="$entry"
    inspected_owner_pid="${BASH_REMATCH[1]}"
    if kill -0 "$inspected_owner_pid" 2>/dev/null; then
      inspected_lock_state="live"
    else
      inspected_lock_state="dead"
    fi
  }

  verify_owned_ledger_lock() {
    inspect_ledger_lock || return 1
    [[ "$inspected_lock_state" == live && \
      "$inspected_owner_marker" == "$ledger_lock_owner_marker" && \
      "$inspected_owner_pid" == "$$" ]]
  }

  release_owned_ledger_lock() {
    if [[ "$owner_marker_created" != true ]]; then
      return 0
    fi
    if ! rm -- "$ledger_lock_owner_marker" 2>/dev/null; then
      owner_marker_created=false
      lock_acquired=false
      return 1
    fi
    owner_marker_created=false
    lock_acquired=false
    rmdir "$ledger_lock" 2>/dev/null || true
  }

  cleanup_ledger_merge() {
    local cleanup_status=0

    rm -f "$ledger_merge_tmp" "$source_suffix_tmp" \
      "$candidate_suffix_tmp" "$source_ids_tmp" "$candidate_ids_tmp" \
      "$overlap_ids_tmp" "$filtered_candidate_tmp" "$resolved_rows_tmp" \
      "$terminal_record_tmp" || cleanup_status=1
    release_owned_ledger_lock || cleanup_status=1
    return "$cleanup_status"
  }

  has_base_ledger_prefix() {
    local target_ledger="$1"
    local target_bytes=""

    target_bytes=$(wc -c < "$target_ledger" | tr -d '[:space:]') || return 1
    if [[ ! "$target_bytes" =~ ^[0-9]+$ || "$target_bytes" -lt "$base_bytes" ]]; then
      return 1
    fi
    cmp -s "$base_ledger" \
      <(dd if="$target_ledger" bs=1 count="$base_bytes" 2>/dev/null)
  }

  trap 'cleanup_ledger_merge; exit 143' TERM
  trap 'cleanup_ledger_merge; exit 130' INT
  trap 'cleanup_ledger_merge; exit 129' HUP
  trap cleanup_ledger_merge EXIT

  perform_issue_ledger_merge() {
  validate_issue_ledger "$base_ledger" || return $?
  validate_issue_ledger "$candidate_ledger" || return $?
  validate_issue_ledger "$ledger" || return $?
  base_bytes=$(wc -c < "$base_ledger" | tr -d '[:space:]') || return 1
  if [[ ! "$base_bytes" =~ ^[1-9][0-9]*$ ]]; then
    echo "invalid issue ledger base snapshot" >&2
    return 65
  fi

  while true; do
    remaining_launcher_ms remaining_ms || return 124
    if [[ "$remaining_ms" -le 100 ]]; then
      echo "timed out acquiring issue ledger lock" >&2
      return 124
    fi
    if mkdir "$ledger_lock" 2>/dev/null; then
      if ! (set -o noclobber; : > "$ledger_lock_owner_marker") 2>/dev/null; then
        rmdir "$ledger_lock" 2>/dev/null || true
        continue
      fi
      owner_marker_created=true
      if ! verify_owned_ledger_lock; then
        release_owned_ledger_lock || true
        continue
      fi
      lock_acquired=true
      break
    fi
    if [[ ! -d "$ledger_lock" ]]; then
      echo "cannot create issue ledger lock" >&2
      return 1
    fi
    inspect_ledger_lock || return 1
    case "$inspected_lock_state" in
      missing)
        continue
        ;;
      empty)
        rmdir "$ledger_lock" 2>/dev/null || true
        continue
        ;;
      dead)
        if rm -- "$inspected_owner_marker" 2>/dev/null; then
          rmdir "$ledger_lock" 2>/dev/null || true
        fi
        continue
        ;;
    esac
    sleep 0.05
  done

  if ! validate_issue_ledger "${ledger}"; then
    return 65
  fi
  if ! has_base_ledger_prefix "$ledger"; then
    echo "source issue ledger no longer has captured append-only base" >&2
    return 65
  fi
  if ! has_base_ledger_prefix "$candidate_ledger"; then
    echo "candidate issue ledger no longer has captured append-only base" >&2
    return 65
  fi
  if ! dd if="$ledger" of="$source_suffix_tmp" bs=1 skip="$base_bytes" \
    2>/dev/null || \
    ! dd if="$candidate_ledger" of="$candidate_suffix_tmp" bs=1 \
      skip="$base_bytes" 2>/dev/null; then
    return 1
  fi
  if [[ "$merge_mode" == terminal* && -s "$source_suffix_tmp" ]]; then
    echo "concurrent source issue ledger append blocks terminal success" >&2
    return 65
  fi
  if [[ "$merge_mode" == terminal-commit ]]; then
    validate_terminal_ledger_publication_paths \
      "$terminal_ledger_stage" "$ledger" || return $?
    if ! validate_issue_ledger "$terminal_ledger_stage" || \
      ! has_base_ledger_prefix "$terminal_ledger_stage" || \
      ! issue_ledger_has_no_latest_open "$terminal_ledger_stage" || \
      ! issue_ledger_has_terminal_commit \
        "$terminal_ledger_stage" "$terminal_commit_id" \
        "$terminal_report_sha256" "$terminal_monitor_sha256" \
        "$terminal_candidate_sha256" \
        "$terminal_latest_projection_sha256"; then
      echo "terminal issue ledger stage is not commit-ready" >&2
      return 65
    fi
    validate_terminal_ledger_publication_paths \
      "$terminal_ledger_stage" "$ledger" || return $?
    current_candidate_sha256=$(sha256_file "$candidate_ledger") || return $?
    current_terminal_ledger_sha256=$(sha256_file \
      "$terminal_ledger_stage") || return $?
    current_report_sha256=$(sha256_file "$report_path") || return $?
    current_monitor_sha256=$(sha256_file "$monitor_path") || return $?
    current_latest_projection_sha256=$(compute_latest_projection_sha256 \
      "$latest") || return $?
    current_latest_projection_claim=$(jq -er '
      .latestProjectionSha256
      | select(type == "string" and test("^[0-9a-f]{64}$"))
    ' "$latest") || return $?
    current_latest_ledger_claim=$(jq -er '
      .ledgerSha256
      | select(type == "string" and test("^[0-9a-f]{64}$"))
    ' "$latest") || return $?
    current_latest_terminal_proof_claim=$(jq -er '
      .terminalProof
      | select(type == "string" and test("^[0-9a-f]{64}$"))
    ' "$latest") || return $?
    if [[ "$current_candidate_sha256" != "$terminal_candidate_sha256" || \
      "$current_terminal_ledger_sha256" != "$terminal_ledger_sha256" || \
      "$current_report_sha256" != "$terminal_report_sha256" || \
      "$current_monitor_sha256" != "$terminal_monitor_sha256" || \
      "$current_latest_projection_sha256" != \
        "$terminal_latest_projection_sha256" || \
      "$current_latest_projection_claim" != \
        "$terminal_latest_projection_sha256" || \
      "$current_latest_ledger_claim" != "$terminal_ledger_sha256" || \
      "$current_latest_terminal_proof_claim" != "$terminal_proof" ]]; then
      echo "terminal issue ledger hash binding changed" >&2
      return 65
    fi
    validate_terminal_ledger_publication_paths \
      "$terminal_ledger_stage" "$ledger" || return $?
    remaining_launcher_ms remaining_ms || return 124
    if [[ "$remaining_ms" -le 0 ]]; then
      return 124
    fi
    if ! mv "$terminal_ledger_stage" "$ledger"; then
      return 1
    fi
    return 0
  fi
  if [[ "$merge_mode" == failure || "$merge_mode" == terminal* ]]; then
    if ! jq -cs '
        reduce .[] as $issue ({}; .[$issue.id] = $issue)
        | [.[]]
        | map(select(.status == "open"))
        | sort_by(.id)
        | .[]
      ' "$candidate_suffix_tmp" \
      > "$filtered_candidate_tmp" || \
      ! mv "$filtered_candidate_tmp" "$candidate_suffix_tmp"; then
      return 1
    fi
  fi
  if ! jq -r '.id' "$source_suffix_tmp" | LC_ALL=C sort -u \
    > "$source_ids_tmp" || \
    ! jq -r '.id' "$candidate_suffix_tmp" | LC_ALL=C sort -u \
      > "$candidate_ids_tmp" || \
    ! LC_ALL=C comm -12 "$source_ids_tmp" "$candidate_ids_tmp" \
      > "$overlap_ids_tmp"; then
    return 1
  fi
  if [[ -s "$overlap_ids_tmp" ]]; then
    IFS= read -r conflict_id < "$overlap_ids_tmp"
    echo "concurrent issue ledger ID conflict: $conflict_id" >&2
    return 65
  fi
  if ! cp "$ledger" "$ledger_merge_tmp" || \
    ! cat "$candidate_suffix_tmp" >> "$ledger_merge_tmp"; then
    return 1
  fi
  if ! validate_issue_ledger "$ledger_merge_tmp"; then
    return 65
  fi
  if [[ "$merge_mode" == terminal || "$merge_mode" == terminal-stage ]]; then
    if [[ -z "${terminal_commit_id:-}" || -z "${terminal_commit_at:-}" || \
      -z "${terminal_report_sha256:-}" || \
      -z "${terminal_monitor_sha256:-}" || \
      -z "${terminal_candidate_sha256:-}" || \
      -z "${terminal_latest_projection_sha256:-}" || \
      -z "${pr_url:-}" ]]; then
      echo "terminal issue ledger context is incomplete" >&2
      return 65
    fi
    if ! jq -cs --arg at "$terminal_commit_at" \
      --arg prUrl "$pr_url" --arg provingRunId "$run_id" \
      --arg backend "${ORCA_BACKEND:-codex}" \
      --arg worktree "$worktree" --arg branch "$branch" \
      --arg monitorPath "$monitor_path" \
      --arg terminalCommitId "$terminal_commit_id" '
        reduce .[] as $issue ({}; .[$issue.id] = $issue)
        | [.[]]
        | map(select(.status == "open"))
        | sort_by(.id)
        | .[]
        | . + {
            at: $at,
            evidence: ("Resolved by committed pull request " + $prUrl),
            prUrl: $prUrl,
            status: "resolved",
            provingRunId: $provingRunId,
            backend: $backend,
            worktree: $worktree,
            branch: $branch,
            monitorPath: $monitorPath,
            terminalCommitId: $terminalCommitId
          }
      ' "$ledger_merge_tmp" > "$resolved_rows_tmp" || \
      ! jq -cn --arg id "terminal-commit-$terminal_commit_id" \
        --arg runId "$run_id" --arg at "$terminal_commit_at" \
        --arg prUrl "$pr_url" --arg backend "${ORCA_BACKEND:-codex}" \
        --arg worktree "$worktree" --arg branch "$branch" \
        --arg monitorPath "$monitor_path" \
        --arg terminalCommitId "$terminal_commit_id" \
        --arg reportSha256 "$terminal_report_sha256" \
        --arg monitorSha256 "$terminal_monitor_sha256" \
        --arg candidateLedgerSha256 "$terminal_candidate_sha256" \
        --arg latestProjectionSha256 \
          "$terminal_latest_projection_sha256" \
        --argjson elapsedMs "${elapsed_ms:-0}" '
          {
            id: $id,
            runId: $runId,
            at: $at,
            classification: "gate",
            stage: "finalize",
            elapsedMs: $elapsedMs,
            evidence: ("Committed terminal proof for " + $prUrl),
            status: "resolved",
            prUrl: $prUrl,
            backend: $backend,
            worktree: $worktree,
            branch: $branch,
            monitorPath: $monitorPath,
            provingRunId: $runId,
            terminalCommit: true,
            terminalCommitId: $terminalCommitId,
            reportSha256: $reportSha256,
            monitorSha256: $monitorSha256,
            candidateLedgerSha256: $candidateLedgerSha256,
            latestProjectionSha256: $latestProjectionSha256
          }
        ' > "$terminal_record_tmp" || \
      ! cat "$resolved_rows_tmp" "$terminal_record_tmp" \
        >> "$ledger_merge_tmp"; then
      return 1
    fi
    if ! validate_issue_ledger "$ledger_merge_tmp" || \
      ! issue_ledger_has_no_latest_open "$ledger_merge_tmp" || \
      ! issue_ledger_has_terminal_commit \
        "$ledger_merge_tmp" "$terminal_commit_id" \
        "$terminal_report_sha256" "$terminal_monitor_sha256" \
        "$terminal_candidate_sha256" \
        "$terminal_latest_projection_sha256"; then
      echo "terminal issue ledger still has latest-open IDs" >&2
      return 65
    fi
    if [[ "$merge_mode" == terminal-stage ]]; then
      if [[ -z "${terminal_ledger_stage:-}" || \
        -z "${terminal_issue_evidence:-}" ]]; then
        return 1
      fi
      validate_terminal_ledger_publication_paths \
        "$terminal_ledger_stage" "$ledger" || return $?
      if ! cp "$ledger_merge_tmp" "$terminal_ledger_stage"; then
        return 1
      fi
      validate_terminal_ledger_publication_paths \
        "$terminal_ledger_stage" "$ledger" || return $?
      return 0
    fi
  fi
  if ! mv "$ledger_merge_tmp" "$ledger"; then
    return 1
  fi
  }

  local merge_status=0
  perform_issue_ledger_merge || merge_status=$?
  if ! cleanup_ledger_merge && [[ "$merge_status" -eq 0 ]]; then
    merge_status=1
  fi
  trap - EXIT TERM INT HUP
  return "$merge_status"
}

github_repository_from_url() {
  local output_name="${1:-}"
  local remote_url="${2:-}"
  local repository_path=""

  if [[ "$#" -ne 2 || \
    ! "$output_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    return 64
  fi
  case "$remote_url" in
    https://github.com/*)
      repository_path="${remote_url#https://github.com/}"
      ;;
    git@github.com:*)
      repository_path="${remote_url#git@github.com:}"
      ;;
    ssh://git@github.com/*)
      repository_path="${remote_url#ssh://git@github.com/}"
      ;;
    *)
      echo "unsupported origin URL; expected GitHub HTTPS or SSH" >&2
      return 66
      ;;
  esac
  repository_path="${repository_path%.git}"
  if [[ ! "$repository_path" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$ || \
    "$repository_path" == */. || "$repository_path" == */.. ]]; then
    echo "unsupported origin URL repository path" >&2
    return 66
  fi
  printf -v "$output_name" '%s' "$repository_path" || return 125
}

lowercase_github_repository() {
  local repository_path="${1:-}"

  if [[ "$#" -ne 1 ]]; then
    return 64
  fi
  printf '%s' "$repository_path" | tr '[:upper:]' '[:lower:]'
}

capture_delivery_identity() {
  local fetch_repository=""
  local push_repository=""
  local fetch_repository_key=""
  local push_repository_key=""

  capture_before_deadline origin_fetch_url git -C "$source_root" \
    remote get-url origin || return $?
  capture_before_deadline origin_push_url git -C "$source_root" \
    remote get-url --push origin || return $?
  github_repository_from_url fetch_repository "$origin_fetch_url" || return $?
  github_repository_from_url push_repository "$origin_push_url" || return $?
  capture_before_deadline fetch_repository_key \
    lowercase_github_repository "$fetch_repository" || return $?
  capture_before_deadline push_repository_key \
    lowercase_github_repository "$push_repository" || return $?
  if [[ "$fetch_repository_key" != "$push_repository_key" ]]; then
    echo "origin fetch and push URLs name different GitHub repositories" >&2
    return 66
  fi
  repository="$fetch_repository"
}

build_runtime() {
  local runtime_source=""
  local build_status=0
  local cleanup_status=0

  runtime_source=$(mktemp -d "${TMPDIR:-/tmp}/orcats-runtime-source.XXXXXX")
  cleanup_runtime_source() {
    if [[ -n "$runtime_source" && \
      ( -e "$runtime_source" || -L "$runtime_source" ) ]]; then
      rm -rf -- "$runtime_source"
    fi
  }
  trap 'cleanup_runtime_source; exit 143' TERM
  trap 'cleanup_runtime_source; exit 130' INT
  trap 'cleanup_runtime_source; exit 129' HUP

  GIT_NO_REPLACE_OBJECTS=1 git -C "$source_root" \
    archive --format=tar "$runtime_head" | \
    tar -xf - -C "$runtime_source" || build_status=$?
  if [[ "$build_status" -eq 0 ]]; then
    (
      cd "$runtime_source"
      bun install --frozen-lockfile
      bun run build:binary
    ) || build_status=$?
  fi
  if [[ "$build_status" -eq 0 && ! -x "$runtime_source/dist/orcats" ]]; then
    echo "clean runtime build did not produce an executable" >&2
    build_status=1
  fi
  if [[ "$build_status" -eq 0 ]]; then
    mkdir -p "$(dirname "$runtime_path")" && \
      cp -p "$runtime_source/dist/orcats" "$runtime_path" || build_status=$?
  fi
  cleanup_runtime_source || cleanup_status=$?
  trap - TERM INT HUP
  if [[ "$build_status" -eq 0 && "$cleanup_status" -ne 0 ]]; then
    build_status="$cleanup_status"
  fi
  return "$build_status"
}

validate_required_merge_protection() {
  local required_check="$1"
  local required_app_id="$2"

  jq -e --arg requiredCheck "$required_check" \
    --argjson requiredAppId "$required_app_id" '
    .required_status_checks.strict == true
    and .enforce_admins.enabled == true
    and any(
      (.required_status_checks.checks // [])[];
      .context == $requiredCheck and .app_id == $requiredAppId
    )
  ' >/dev/null
}

assert_required_merge_protection() {
  local protection=""

  protection=$(gh api "repos/$repository/branches/main/protection") || return $?
  if ! printf '%s\n' "$protection" | \
    validate_required_merge_protection "Verify" "15368"; then
    echo "main must require strict administrator-enforced Verify from GitHub Actions app 15368" >&2
    return 66
  fi
}

run_preflight_gates() {
  assert_required_merge_protection
  bun test ./.orca/workflows/codebase-improvement-lib.test.ts \
    ./.orca/workflows/codebase-improvement-runtime.test.ts \
    ./.orca/workflows/codebase-improvement-contract.test.ts \
    ./.orca/workflows/codebase-improvement-artifacts.test.ts
  bash skills/orcats-author/scripts/orca-typecheck-flow.sh \
    .orca/workflows/codebase-improvement.ts
  bun test
  bun run lint
}

run_live_workflow() {
  PATH="$(dirname "$runtime_path"):$PATH" \
  ORCA_IMPROVEMENT_RUN_ID="$run_id" \
  ORCA_IMPROVEMENT_BRANCH="$branch" \
  ORCA_IMPROVEMENT_STARTED_AT_MS="$started_at_ms" \
  ORCA_IMPROVEMENT_WORKER_DEADLINE_AT_MS="$launcher_work_deadline_at_ms" \
  ORCA_IMPROVEMENT_ARTIFACT_DIGEST="$artifact_digest" \
  ORCA_IMPROVEMENT_PREFLIGHT_PATH="$preflight_path" \
  ORCA_IMPROVEMENT_ORIGIN_FETCH_URL="$origin_fetch_url" \
  ORCA_IMPROVEMENT_ORIGIN_PUSH_URL="$origin_push_url" \
  ORCA_IMPROVEMENT_REPOSITORY="$repository" \
  bash skills/orcats-flow/scripts/orca-run.sh \
    .orca/workflows/codebase-improvement.ts -- \
    --baseline=strict "--complexity=$complexity"
}

compute_preflight_terminal_proof() {
  local proof_run_id="$1"
  local proof_runtime_head="$2"
  local proof_runtime_sha256="$3"
  local proof_base_sha="$4"
  local proof_artifact_digest="$5"
  local proof_origin_fetch_url="$6"
  local proof_origin_push_url="$7"
  local proof_repository="$8"
  local proof_checked_at="$9"
  local proof_elapsed_ms="${10}"
  local proof_worker_exit_code="${11}"
  local proof_worker_completed_at_ms="${12}"
  local proof_supervisor_status="${13}"
  local proof_checked_at_ms="${14}"
  local proof_expires_at_ms="${15}"

  jq -cnS --arg runId "$proof_run_id" \
    --arg runtimeHead "$proof_runtime_head" \
    --arg runtimeSha256 "$proof_runtime_sha256" \
    --arg baseSha "$proof_base_sha" \
    --arg artifactDigest "$proof_artifact_digest" \
    --arg originFetchUrl "$proof_origin_fetch_url" \
    --arg originPushUrl "$proof_origin_push_url" \
    --arg repository "$proof_repository" \
    --arg checkedAt "$proof_checked_at" \
    --arg supervisorStatus "$proof_supervisor_status" \
    --argjson elapsedMs "$proof_elapsed_ms" \
    --argjson workerExitCode "$proof_worker_exit_code" \
    --argjson workerCompletedAtMs "$proof_worker_completed_at_ms" \
    --argjson checkedAtMs "$proof_checked_at_ms" \
    --argjson expiresAtMs "$proof_expires_at_ms" \
    '{runId:$runId,runtimeHead:$runtimeHead,runtimeSha256:$runtimeSha256,baseSha:$baseSha,artifactDigest:$artifactDigest,originFetchUrl:$originFetchUrl,originPushUrl:$originPushUrl,repository:$repository,checkedAt:$checkedAt,status:"succeeded",exitCode:0,elapsedMs:$elapsedMs,workerExitCode:$workerExitCode,workerCompletedAtMs:$workerCompletedAtMs,supervisorStatus:$supervisorStatus,checkedAtMs:$checkedAtMs,expiresAtMs:$expiresAtMs}' | \
    shasum -a 256 | awk '{print $1}'
}

publish_preflight_attestation() {
  local publish_path="${1:-$preflight_path}"
  local preflight_tmp="${publish_path}.tmp.$$"
  local checked_at=""
  local checked_at_ms=""
  local expires_at_ms=""
  local supervisor_status="terminal"
  local terminal_proof=""
  local validity_ms="${preflight_validity_ms:-600000}"

  checked_at=$(date -u +%Y-%m-%dT%H:%M:%SZ) || return 1
  checked_at_ms=$(now_ms) || return 1
  if [[ ! "$checked_at_ms" =~ ^[0-9]+$ || \
    ! "$validity_ms" =~ ^[0-9]+$ || \
    ! "$elapsed_ms" =~ ^[0-9]+$ || \
    ! "$preflight_worker_exit_code" =~ ^[0-9]+$ || \
    ! "$preflight_worker_completed_at_ms" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  if [[ -z "$origin_fetch_url" || -z "$origin_push_url" || \
    -z "$repository" ]]; then
    return 1
  fi
  expires_at_ms=$(( checked_at_ms + validity_ms ))
  terminal_proof=$(compute_preflight_terminal_proof \
    "$run_id" "$runtime_head" "$runtime_sha256" "$base_sha" \
    "$artifact_digest" "$origin_fetch_url" "$origin_push_url" \
    "$repository" "$checked_at" "$elapsed_ms" \
    "$preflight_worker_exit_code" "$preflight_worker_completed_at_ms" \
    "$supervisor_status" "$checked_at_ms" "$expires_at_ms") || return 1

  if ! jq -n --arg runId "$run_id" --arg runtimeHead "$runtime_head" \
    --arg runtimeSha256 "$runtime_sha256" \
    --arg baseSha "$base_sha" \
    --arg artifactDigest "$artifact_digest" \
    --arg originFetchUrl "$origin_fetch_url" \
    --arg originPushUrl "$origin_push_url" \
    --arg repository "$repository" \
    --arg checkedAt "$checked_at" \
    --arg supervisorStatus "$supervisor_status" \
    --arg terminalProof "$terminal_proof" \
    --argjson elapsedMs "$elapsed_ms" \
    --argjson workerExitCode "$preflight_worker_exit_code" \
    --argjson workerCompletedAtMs "$preflight_worker_completed_at_ms" \
    --argjson checkedAtMs "$checked_at_ms" \
    --argjson expiresAtMs "$expires_at_ms" \
    '{runId:$runId,runtimeHead:$runtimeHead,runtimeSha256:$runtimeSha256,baseSha:$baseSha,artifactDigest:$artifactDigest,originFetchUrl:$originFetchUrl,originPushUrl:$originPushUrl,repository:$repository,checkedAt:$checkedAt,status:"succeeded",exitCode:0,elapsedMs:$elapsedMs,workerExitCode:$workerExitCode,workerCompletedAtMs:$workerCompletedAtMs,supervisorStatus:$supervisorStatus,checkedAtMs:$checkedAtMs,expiresAtMs:$expiresAtMs,terminalProof:$terminalProof}' \
    > "$preflight_tmp"
  then
    rm -f "$preflight_tmp"
    return 1
  fi
  if ! mv "$preflight_tmp" "$publish_path"; then
    rm -f "$preflight_tmp"
    return 1
  fi
}

claim_preflight_attestation() {
  local stable_path="$1"
  local claimed_path="$2"
  local claim_status=0

  if [[ ! -f "$stable_path" ]]; then
    echo "missing successful preflight attestation: $stable_path" >&2
    return 66
  fi
  if [[ -e "$claimed_path" ]]; then
    echo "preflight claim already exists: $claimed_path" >&2
    return 66
  fi
  run_before_deadline mkdir -p "$(dirname "$claimed_path")" || return $?
  run_before_deadline mv "$stable_path" "$claimed_path" || claim_status=$?
  if [[ "$claim_status" -ne 0 ]]; then
    if [[ "$claim_status" -eq 124 ]]; then
      return 124
    fi
    echo "preflight attestation was already claimed" >&2
    return 66
  fi
  preflight_path="$claimed_path"
}

validate_claimed_preflight_attestation() {
  local claimed_path="$1"
  local current_ms=""
  local validity_ms="${preflight_validity_ms:-600000}"
  local attestation_values=""
  local attested_run_id=""
  local attested_runtime_head=""
  local attested_runtime_sha256=""
  local attested_base_sha=""
  local attested_artifact_digest=""
  local attested_origin_fetch_url=""
  local attested_origin_push_url=""
  local attested_repository=""
  local attested_checked_at=""
  local attested_elapsed_ms=""
  local attested_worker_exit_code=""
  local attested_worker_completed_at_ms=""
  local attested_supervisor_status=""
  local attested_checked_at_ms=""
  local attested_expires_at_ms=""
  local attested_terminal_proof=""
  local expected_terminal_proof=""

  capture_before_deadline current_ms now_ms || return 124
  if [[ ! "$current_ms" =~ ^[0-9]+$ || ! "$validity_ms" =~ ^[0-9]+$ ]]; then
    echo "preflight freshness clock is invalid" >&2
    return 66
  fi
  if ! run_before_deadline jq -e \
    --argjson currentMs "$current_ms" \
    --argjson validityMs "$validity_ms" '
      def uint:
        type == "number" and . >= 0 and . <= 9007199254740991 and floor == .;
      type == "object" and
      (.runId | type == "string" and length > 0) and
      (.runtimeHead | type == "string" and length > 0) and
      (.runtimeSha256 | type == "string" and length > 0) and
      (.baseSha | type == "string" and length > 0) and
      (.artifactDigest | type == "string" and length > 0) and
      (.originFetchUrl | type == "string" and length > 0) and
      (.originPushUrl | type == "string" and length > 0) and
      (.repository | type == "string" and length > 0) and
      (.checkedAt | type == "string" and length > 0) and
      (.status == "succeeded") and
      (.exitCode | type == "number" and . == 0) and
      (.elapsedMs | uint) and
      (.workerExitCode | type == "number" and . == 0) and
      (.workerCompletedAtMs | uint) and
      (.supervisorStatus == "terminal") and
      (.checkedAtMs | uint) and
      (.expiresAtMs | uint) and
      (.terminalProof | type == "string" and test("^[0-9a-f]{64}$")) and
      .workerCompletedAtMs <= .checkedAtMs and
      .checkedAtMs <= $currentMs and
      $currentMs <= .expiresAtMs and
      .expiresAtMs == (.checkedAtMs + $validityMs)
    ' "$claimed_path" >/dev/null
  then
    echo "preflight attestation is not fresh terminal success" >&2
    return 66
  fi

  capture_before_deadline attestation_values jq -r '
    [.runId,.runtimeHead,.runtimeSha256,.baseSha,.artifactDigest,
     .originFetchUrl,.originPushUrl,.repository,.checkedAt,.elapsedMs,
     .workerExitCode,.workerCompletedAtMs,.supervisorStatus,.checkedAtMs,
     .expiresAtMs,.terminalProof] | @tsv
  ' "$claimed_path" || return 66
  IFS=$'\t' read -r attested_run_id attested_runtime_head \
    attested_runtime_sha256 attested_base_sha attested_artifact_digest \
    attested_origin_fetch_url attested_origin_push_url attested_repository \
    attested_checked_at attested_elapsed_ms attested_worker_exit_code \
    attested_worker_completed_at_ms attested_supervisor_status \
    attested_checked_at_ms attested_expires_at_ms attested_terminal_proof \
    <<< "$attestation_values"

  capture_before_deadline expected_terminal_proof \
    compute_preflight_terminal_proof \
    "$attested_run_id" "$attested_runtime_head" \
    "$attested_runtime_sha256" "$attested_base_sha" \
    "$attested_artifact_digest" "$attested_origin_fetch_url" \
    "$attested_origin_push_url" "$attested_repository" \
    "$attested_checked_at" \
    "$attested_elapsed_ms" "$attested_worker_exit_code" \
    "$attested_worker_completed_at_ms" "$attested_supervisor_status" \
    "$attested_checked_at_ms" "$attested_expires_at_ms" || return 66
  if [[ "$attested_terminal_proof" != "$expected_terminal_proof" ]]; then
    echo "preflight terminal proof is invalid" >&2
    return 66
  fi
  if [[ ! -f "$latest_quarantine" || -L "$latest_quarantine" ]]; then
    echo "preflight latest evidence is missing" >&2
    return 66
  fi
  if ! run_before_deadline jq -e \
    --arg runId "$attested_run_id" \
    --arg runtimeHead "$attested_runtime_head" \
    --arg runtimeSha256 "$attested_runtime_sha256" \
    --arg baseSha "$attested_base_sha" \
    --arg artifactDigest "$attested_artifact_digest" '
      type == "object" and
      .mode == "preflight" and
      .runId == $runId and
      .runtimeHead == $runtimeHead and
      .runtimeSha256 == $runtimeSha256 and
      .baseSha == $baseSha and
      .artifactDigest == $artifactDigest and
      .preflightArtifactDigest == $artifactDigest and
      .preflightBaseSha == $baseSha and
      (.exitCode | type == "number" and . == 0)
    ' "$latest_quarantine" >/dev/null
  then
    echo "preflight latest evidence does not match the claimed success" >&2
    return 66
  fi
  if [[ "$attested_run_id" == "$run_id" ]]; then
    echo "preflight and live run IDs are not distinct" >&2
    return 66
  fi
  if [[ "$attested_artifact_digest" != "$artifact_digest" ]]; then
    echo "preflight artifact digest does not match live artifacts" >&2
    return 66
  fi
  if [[ "$attested_origin_fetch_url" != "$origin_fetch_url" || \
    "$attested_origin_push_url" != "$origin_push_url" || \
    "$attested_repository" != "$repository" ]]; then
    echo "preflight delivery identity does not match live origin" >&2
    return 66
  fi
  if [[ "$attested_runtime_head" != "$runtime_head" ]]; then
    echo "preflight source HEAD does not match live source HEAD" >&2
    return 66
  fi
  if [[ "$attested_runtime_sha256" != "$runtime_sha256" ]]; then
    echo "preflight runtime SHA-256 does not match live runtime" >&2
    return 66
  fi
  preflight_artifact_digest="$attested_artifact_digest"
  preflight_base_sha="$attested_base_sha"
}

write_failure_tombstone() {
  local tombstone="$1"
  local status="$2"

  printf '{"runId":"%s","status":"failed","exitCode":%s}\n' \
    "$run_id" "$status" > "$tombstone"
}

render_latest_evidence_action() {
  jq -n --arg runId "$run_id" --arg branch "$branch" \
    --arg worktree "$worktree" --arg profile "$complexity" \
    --arg mode "$mode" --arg phase "$phase" \
    --arg launcherLog "$launcher_log" --arg monitor "$monitor_path" \
    --arg report "$report_path" --arg ledger "$ledger" --arg prUrl "$pr_url" \
    --arg runtimePath "$runtime_path" --arg runtimeHead "$runtime_head" \
    --arg runtimeSha256 "$runtime_sha256" \
    --arg runtimeVersion "$runtime_version" \
    --arg baseSha "$final_base_sha" \
    --arg artifactDigest "$final_artifact_digest" \
    --arg preflightPath "$final_preflight_path" \
    --arg preflightArtifactDigest "$final_preflight_digest" \
    --arg preflightBaseSha "$final_preflight_base_sha" \
    --arg protectedPackageLock "$final_protected_package_lock" \
    --arg packageLockSha256Before "$final_package_lock_before" \
    --arg packageLockSha256After "$final_package_lock_after" \
    --arg terminalCommitId "$terminal_commit_id" \
    --arg ledgerSha256 "$terminal_ledger_sha256" \
    --arg candidateLedgerSha256 "$terminal_candidate_sha256" \
    --arg reportSha256 "$terminal_report_sha256" \
    --arg monitorSha256 "$terminal_monitor_sha256" \
    --arg latestProjectionSha256 "$latest_projection_sha256" \
    --arg terminalProof "$terminal_proof" \
    --argjson elapsedMs "$elapsed_ms" --argjson exitCode "$final_status" \
    '{runId:$runId,branch:$branch,worktree:$worktree,profile:$profile,mode:$mode,phase:$phase,launcherLog:$launcherLog,monitor:$monitor,report:$report,ledger:$ledger,prUrl:$prUrl,runtimePath:$runtimePath,runtimeHead:$runtimeHead,runtimeSha256:$runtimeSha256,runtimeVersion:$runtimeVersion,baseSha:$baseSha,artifactDigest:$artifactDigest,preflightPath:$preflightPath,preflightArtifactDigest:$preflightArtifactDigest,preflightBaseSha:$preflightBaseSha,protectedPackageLock:$protectedPackageLock,packageLockSha256Before:$packageLockSha256Before,packageLockSha256After:$packageLockSha256After,terminalCommitId:$terminalCommitId,ledgerSha256:$ledgerSha256,candidateLedgerSha256:$candidateLedgerSha256,reportSha256:$reportSha256,monitorSha256:$monitorSha256,latestProjectionSha256:$latestProjectionSha256,terminalProof:$terminalProof,elapsedMs:$elapsedMs,exitCode:$exitCode} | if $latestProjectionSha256 == "" then del(.latestProjectionSha256) else . end' \
    > "$latest_tmp"
}

finalize() {
  local original_status="$?"

  if [[ "$launcher_finalization_ready" != true ]]; then
    trap - EXIT
    exit "$original_status"
  fi
  launcher_deadline_at_ms="$launcher_absolute_deadline_at_ms"
  local final_status="$original_status"
  local ended_at_ms=""
  local latest_tmp="${latest}.tmp.$$"
  local candidate_ledger="$worktree/.orca/improvement-loop/issues.jsonl"
  local launcher_deadline_ms="${launcher_deadline_ms:-600000}"
  local final_artifact_digest="${artifact_digest:-}"
  local final_base_sha="${base_sha:-}"
  local final_preflight_path="${preflight_path:-}"
  local final_preflight_digest="${preflight_artifact_digest:-}"
  local final_preflight_base_sha="${preflight_base_sha:-}"
  local final_protected_package_lock="${protected_package_lock:-}"
  local final_package_lock_before="${package_lock_sha256_before:-}"
  local final_package_lock_after="${package_lock_sha256_after:-}"
  local preflight_stage="${preflight_path}.stage.$$"
  local preflight_staged=false
  local terminal_commit_owned=false
  local terminal_commit_signal_status=0
  local terminal_commit_id="$run_id.$RANDOM"
  local terminal_commit_at=""
  local terminal_ledger_stage=""
  local terminal_issue_evidence="$run_dir/issues.jsonl"
  local terminal_candidate_sha256=""
  local terminal_ledger_sha256=""
  local terminal_report_sha256=""
  local terminal_monitor_sha256=""
  local terminal_latest_projection_sha256=""
  local terminal_proof=""
  local require_successful_monitor=false
  local terminal_report_rejected=false
  local latest_parent="${latest%/*}"

  if [[ "$launcher_signal_status" -ne 0 ]]; then
    final_status="$launcher_signal_status"
  fi

  record_finalize_failure() {
    echo "finalize failed: $1" >&2
    if [[ "$launcher_signal_status" -ne 0 ]]; then
      final_status="$launcher_signal_status"
    elif [[ "$final_status" -eq 0 ]]; then
      final_status=74
    fi
  }

  discard_preflight_stage() {
    if [[ ! -e "$preflight_stage" && ! -L "$preflight_stage" ]]; then
      preflight_staged=false
      return 0
    fi
    if ! discard_private_path_before_deadline "$preflight_stage"; then
      record_finalize_failure "remove private preflight staging"
      return 1
    fi
    if [[ ! -e "$preflight_stage" && ! -L "$preflight_stage" ]]; then
      preflight_staged=false
    fi
  }

  discard_latest_stage() {
    if [[ ! -e "$latest_tmp" && ! -L "$latest_tmp" ]]; then
      return 0
    fi
    if ! discard_private_path_before_deadline "$latest_tmp"; then
      record_finalize_failure "remove private latest staging"
      return 1
    fi
  }

  discard_terminal_ledger_stage() {
    if [[ -z "$terminal_ledger_stage" || \
      ( ! -e "$terminal_ledger_stage" && \
      ! -L "$terminal_ledger_stage" ) ]]; then
      return 0
    fi
    discard_private_path_before_deadline "$terminal_ledger_stage"
  }

  quarantine_current_latest() {
    if [[ ! -e "$latest" && ! -L "$latest" ]]; then
      return 0
    fi
    if ! atomic_rename_before_deadline \
      "$latest" "$latest_tmp" validate_regular_publication_file;
    then
      record_finalize_failure "quarantine current latest evidence"
      return 1
    fi
  }

  publish_latest_failure_tombstone() {
    local status="$1"
    local tombstone="${latest}.failure.${run_id}.$$"

    if [[ ! "$status" =~ ^[1-9][0-9]*$ ]]; then
      status=74
    fi
    if [[ -e "$tombstone" || -L "$tombstone" ]]; then
      return 1
    fi
    if ! run_before_deadline write_failure_tombstone "$tombstone" "$status"; then
      return 1
    fi
    if ! atomic_rename_before_deadline \
      "$tombstone" "$latest" validate_failure_tombstone_file \
      "$run_id" "$status";
    then
      discard_private_path_before_deadline "$tombstone" || true
      return 1
    fi
  }

  discard_ledger_snapshot() {
    if [[ -z "${ledger_base_snapshot:-}" || \
      ( ! -e "$ledger_base_snapshot" && ! -L "$ledger_base_snapshot" ) ]]; then
      return 0
    fi
    if ! discard_private_path_before_deadline "$ledger_base_snapshot"; then
      record_finalize_failure "remove issue ledger base snapshot"
      return 1
    fi
    if [[ ! -e "$ledger_base_snapshot" && ! -L "$ledger_base_snapshot" ]]; then
      ledger_base_snapshot=""
    fi
  }

  published_evidence_absent() {
    if [[ -e "$latest" || -L "$latest" ]]; then
      return 1
    fi
    if [[ "$mode" == preflight && \
      ( -e "$preflight_path" || -L "$preflight_path" ) ]]; then
      return 1
    fi
  }

  handle_finalize_signal() {
    local status="$1"
    local signal_preflight_fallback="${preflight_path}.signal.${run_id}"
    local signal_latest_fallback="${latest}.signal.${run_id}"

    if [[ "$terminal_commit_owned" == true ]]; then
      if [[ "$terminal_commit_signal_status" -eq 0 ]]; then
        terminal_commit_signal_status="$status"
      fi
      return
    fi
    launcher_signal_status="$status"
    discard_terminal_ledger_stage || true
    if ! quarantine_prior_evidence "$preflight_stage" "$latest_tmp"; then
      echo "finalize failed: quarantine prior evidence after signal" >&2
      discard_preflight_stage || true
      discard_latest_stage || true
      quarantine_prior_evidence \
        "$signal_preflight_fallback" "$signal_latest_fallback" || \
        echo "finalize failed: retry quarantine after signal" >&2
    fi
    discard_ledger_snapshot || true
    discard_preflight_stage || true
    discard_latest_stage || true
    if ! discard_private_path_before_deadline "$signal_preflight_fallback"; then
      echo "finalize failed: remove signal quarantine evidence" >&2
    fi
    if ! discard_private_path_before_deadline "$signal_latest_fallback"; then
      echo "finalize failed: remove signal quarantine evidence" >&2
    fi
    if ! published_evidence_absent; then
      quarantine_prior_evidence "$preflight_stage" "$latest_tmp" || \
        echo "finalize failed: verified quarantine after signal" >&2
      discard_preflight_stage || true
      discard_latest_stage || true
    fi
    if ! published_evidence_absent; then
      echo "finalize failed: canonical evidence remains after signal" >&2
    fi
    exit "$status"
  }

  release_failed_terminal_commit() {
    local status="$1"

    terminal_commit_owned=false
    if [[ "$terminal_commit_signal_status" -ne 0 ]]; then
      launcher_signal_status="$terminal_commit_signal_status"
      return "$terminal_commit_signal_status"
    fi
    return "$status"
  }

  commit_terminal_evidence() {
    local commit_status=0
    local failure_tombstone_status=74
    local preflight_commit_status=0
    local terminal_ledger_recovery_status=0
    local terminal_ledger_status=0

    if [[ "$final_status" -ne 0 ]]; then
      discard_terminal_ledger_stage || commit_status=$?
      if [[ "$commit_status" -ne 0 ]]; then
        release_failed_terminal_commit "$commit_status"
        return $?
      fi
    fi
    atomic_rename_before_deadline \
      "$latest_tmp" "$latest" validate_latest_publication_file \
      "$run_id" "$final_status" || commit_status=$?
    if [[ "$launcher_signal_status" -ne 0 ]]; then
      handle_finalize_signal "$launcher_signal_status"
    fi
    if [[ "$commit_status" -ne 0 ]]; then
      release_failed_terminal_commit "$commit_status"
      return $?
    fi
    if [[ "$mode" == live && "$final_status" -eq 0 ]]; then
      terminal_commit_owned=true
      if [[ "$terminal_commit_signal_status" -ne 0 ]]; then
        release_failed_terminal_commit "$terminal_commit_signal_status"
        return $?
      fi
      run_before_deadline_with_reserve "$canonical_recovery_reserve_ms" \
        merge_issue_ledger "$candidate_ledger" "$ledger_base_snapshot" \
        terminal-commit || terminal_ledger_status=$?
      if [[ "$terminal_ledger_status" -ne 0 && \
        "$terminal_commit_signal_status" -eq 0 ]]; then
        run_before_deadline validate_terminal_ledger_recovery \
          "$ledger" "$terminal_ledger_sha256" "$terminal_commit_id" \
          "$terminal_report_sha256" "$terminal_monitor_sha256" \
          "$terminal_candidate_sha256" \
          "$terminal_latest_projection_sha256" || \
          terminal_ledger_recovery_status=$?
        if [[ "$terminal_commit_signal_status" -ne 0 ]]; then
          terminal_ledger_status="$terminal_commit_signal_status"
        elif [[ "$terminal_ledger_recovery_status" -eq 0 ]]; then
          terminal_ledger_status=0
        fi
      fi
      if [[ "$terminal_ledger_status" -ne 0 ]]; then
        release_failed_terminal_commit "$terminal_ledger_status"
        return $?
      fi
      discard_private_path_before_deadline \
        "$ledger_base_snapshot" 2>/dev/null || true
      ledger_base_snapshot=""
      exit 0
    fi
    if [[ "$mode" != preflight || "$final_status" -ne 0 ]]; then
      exit "$final_status"
    fi

    atomic_rename_before_deadline \
      "$preflight_stage" "$preflight_path" \
      validate_preflight_publication_file "$run_id" || \
      preflight_commit_status=$?
    if [[ "$launcher_signal_status" -ne 0 ]]; then
      handle_finalize_signal "$launcher_signal_status"
    fi
    if [[ "$preflight_commit_status" -eq 0 ]]; then
      terminal_commit_owned=true
      exit 0
    fi
    if ! quarantine_current_latest; then
      if [[ "$terminal_commit_signal_status" -ne 0 ]]; then
        failure_tombstone_status="$terminal_commit_signal_status"
      elif [[ "$final_status" -ne 0 ]]; then
        failure_tombstone_status="$final_status"
      fi
      publish_latest_failure_tombstone "$failure_tombstone_status" || true
    fi
    release_failed_terminal_commit "$preflight_commit_status"
    return $?
  }

  prepare_terminal_ledger_evidence() {
    capture_before_deadline terminal_ledger_stage \
      create_terminal_ledger_stage "$ledger" || return $?
    capture_before_deadline terminal_commit_at \
      date -u +"%Y-%m-%dT%H:%M:%SZ" || return $?
    capture_before_deadline terminal_candidate_sha256 sha256_file \
      "$candidate_ledger" || return $?
    capture_before_deadline terminal_report_sha256 \
      sha256_file "$report_path" || return $?
    capture_before_deadline terminal_monitor_sha256 \
      sha256_file "$monitor_path" || return $?
    render_latest_evidence || return $?
    capture_before_deadline terminal_latest_projection_sha256 \
      compute_latest_projection_sha256 "$latest_tmp" || return $?
    run_before_deadline rm -f "$latest_tmp" || return $?
    run_before_deadline merge_issue_ledger \
      "$candidate_ledger" "$ledger_base_snapshot" terminal-stage || return $?
    run_before_deadline validate_terminal_ledger_publication_paths \
      "$terminal_ledger_stage" "$ledger" || return $?
    capture_before_deadline terminal_ledger_sha256 sha256_file \
      "$terminal_ledger_stage" || return $?
    capture_before_deadline terminal_proof compute_terminal_ledger_proof \
      "$terminal_commit_id" "$terminal_ledger_sha256" \
      "$terminal_candidate_sha256" "$terminal_report_sha256" \
      "$terminal_monitor_sha256" \
      "$terminal_latest_projection_sha256" || return $?
    if [[ ! "$terminal_ledger_sha256" =~ ^[0-9a-f]{64}$ || \
      ! "$terminal_candidate_sha256" =~ ^[0-9a-f]{64}$ || \
      ! "$terminal_report_sha256" =~ ^[0-9a-f]{64}$ || \
      ! "$terminal_monitor_sha256" =~ ^[0-9a-f]{64}$ || \
      ! "$terminal_latest_projection_sha256" =~ ^[0-9a-f]{64}$ || \
      ! "$terminal_proof" =~ ^[0-9a-f]{64}$ ]]; then
      echo "terminal evidence hash is invalid" >&2
      return 65
    fi
  }

  render_latest_evidence() {
    local latest_projection_sha256="$terminal_latest_projection_sha256"

    if [[ "$final_status" -ne 0 ]]; then
      latest_projection_sha256=""
    fi
    run_before_deadline render_latest_evidence_action
  }

  trap - EXIT
  trap 'handle_finalize_signal 143' TERM
  trap 'handle_finalize_signal 130' INT
  trap 'handle_finalize_signal 129' HUP
  set +e

  if ! quarantine_prior_evidence; then
    record_finalize_failure "quarantine prior evidence"
  fi
  if ! run_before_deadline mkdir -p "$run_dir" "$latest_parent"; then
    record_finalize_failure "create evidence directories"
  fi
  if [[ -d "$worktree/.orca/monitoring" ]]; then
    if ! run_before_deadline cp -R \
      "$worktree/.orca/monitoring" "$run_dir/monitoring";
    then
      record_finalize_failure "copy monitor evidence"
    fi
  fi
  if [[ -d "$worktree/.orca/improvement-loop/runs/$run_id" ]]; then
    if ! run_before_deadline cp -R "$worktree/.orca/improvement-loop/runs/$run_id" "$run_dir/workflow";
    then
      record_finalize_failure "copy workflow evidence"
    fi
  fi
  if [[ -f "$candidate_ledger" ]]; then
    if ! run_before_deadline validate_issue_ledger "$candidate_ledger"; then
      record_finalize_failure "validate candidate issue ledger"
    elif ! run_before_deadline cp "$candidate_ledger" "$run_dir/issues.jsonl"; then
      record_finalize_failure "copy run issue evidence"
    fi
  fi

  if [[ "$mode" == live && "$original_status" -eq 0 ]]; then
    if [[ ! -d "$run_dir/monitoring" ]]; then
      record_finalize_failure "missing monitor evidence"
    fi
    if [[ ! -f "$run_dir/workflow/report.json" ]]; then
      record_finalize_failure "missing workflow report"
    fi
    if [[ ! -f "$run_dir/issues.jsonl" ]]; then
      record_finalize_failure "missing issue ledger evidence"
    fi
  fi

  if [[ -d "$run_dir/monitoring" ]]; then
    require_successful_monitor=false
    if [[ "$mode" == live && "$original_status" -eq 0 ]]; then
      require_successful_monitor=true
    fi
    if ! capture_before_deadline monitor_path select_terminal_monitor \
      "$run_dir/monitoring" "$require_successful_monitor";
    then
      monitor_path=""
      record_finalize_failure "locate terminal monitor evidence"
    fi
  fi
  if [[ "$mode" == live && "$original_status" -eq 0 && -z "$monitor_path" ]]; then
    record_finalize_failure "missing monitor log"
  fi
  if [[ -f "$run_dir/workflow/report.json" ]]; then
    report_path="$run_dir/workflow/report.json"
    if ! capture_before_deadline pr_url jq -r \
      '.prUrl // ""' "$report_path"; then
      pr_url=""
      record_finalize_failure "read pull request evidence"
    fi
  fi
  if [[ "$mode" == live && "$original_status" -eq 0 && -z "$pr_url" ]]; then
    record_finalize_failure "missing pull request evidence"
  fi
  if [[ "$mode" == live && "$original_status" -eq 0 && \
    -n "$report_path" && -n "$monitor_path" ]]; then
    if ! run_before_deadline validate_terminal_report \
      "$report_path" "$monitor_path" "$launcher_work_deadline_at_ms";
    then
      terminal_report_rejected=true
      record_finalize_failure "validate terminal report"
    fi
  fi
  if ! assert_package_lock_unchanged; then
    record_finalize_failure "preserve primary package-lock"
  fi
  final_package_lock_after="${package_lock_sha256_after:-}"
  if ! capture_before_deadline ended_at_ms now_ms; then
    ended_at_ms=""
    record_finalize_failure "capture completion time"
  fi
  if [[ "$started_at_ms" =~ ^[0-9]+$ && "$ended_at_ms" =~ ^[0-9]+$ ]]; then
    elapsed_ms=$(( ended_at_ms - started_at_ms ))
    if [[ "$elapsed_ms" -gt "$launcher_deadline_ms" ]]; then
      record_finalize_failure "launcher exceeded profile deadline"
    fi
  else
    record_finalize_failure "compute elapsed time"
  fi

  if [[ "$mode" == preflight && "$final_status" -eq 0 ]]; then
    if [[ "$preflight_worker_exit_code" != 0 || \
      ! "$preflight_worker_completed_at_ms" =~ ^[0-9]+$ ]]; then
      record_finalize_failure "missing successful preflight worker proof"
    else
      preflight_artifact_digest="$artifact_digest"
      preflight_base_sha="$base_sha"
      final_preflight_digest="$preflight_artifact_digest"
      final_preflight_base_sha="$preflight_base_sha"
      if run_before_deadline publish_preflight_attestation "$preflight_stage"; then
        preflight_staged=true
      else
        record_finalize_failure "stage preflight attestation"
      fi
    fi
  fi

  if capture_before_deadline ended_at_ms now_ms && \
    [[ "$started_at_ms" =~ ^[0-9]+$ ]]; then
    elapsed_ms=$(( ended_at_ms - started_at_ms ))
    if [[ "$elapsed_ms" -gt "$launcher_deadline_ms" ]]; then
      record_finalize_failure "finalization exceeded profile deadline"
    fi
  else
    record_finalize_failure "capture final elapsed time"
  fi
  if [[ "$mode" == preflight && "$final_status" -ne 0 ]]; then
    discard_preflight_stage || true
  fi

  if [[ "$final_status" -eq 0 ]]; then
    if ! assert_package_lock_unchanged; then
      record_finalize_failure "preserve primary package-lock at terminal commit"
      final_package_lock_after="${package_lock_sha256_after:-}"
      discard_preflight_stage || true
    fi
  fi

  if [[ "$mode" == live && "$final_status" -eq 0 ]]; then
    if ! prepare_terminal_ledger_evidence; then
      record_finalize_failure "prepare terminal issue ledger"
    fi
  fi

  if [[ "$mode" == live && "$final_status" -ne 0 && \
    "$terminal_report_rejected" != true && \
    -f "$candidate_ledger" ]]; then
    if ! run_before_deadline merge_issue_ledger \
      "$candidate_ledger" "$ledger_base_snapshot" failure; then
      record_finalize_failure "merge failed-run issue ledger"
    fi
    if [[ -f "$ledger" ]] && \
      ! run_before_deadline cp "$ledger" "$run_dir/issues.jsonl"; then
      record_finalize_failure "copy failed-run issue evidence"
    fi
  fi
  if [[ "$mode" != live || "$final_status" -ne 0 ]]; then
    discard_ledger_snapshot || true
  fi

  if [[ "$mode" == preflight && "$final_status" -eq 0 && \
    "$preflight_staged" != true ]]; then
    record_finalize_failure "prepare terminal preflight publication"
  fi

  if ! render_latest_evidence; then
    discard_latest_stage || true
    record_finalize_failure "render latest run evidence"
    discard_preflight_stage || true
    if ! render_latest_evidence; then
      discard_latest_stage || true
    fi
  fi

  echo "run_id=$run_id"
  echo "branch=$branch"
  echo "worktree=$worktree"
  echo "elapsed_ms=$elapsed_ms"
  echo "monitor=$monitor_path"
  echo "report=$report_path"
  echo "ledger=$ledger"
  echo "pr_url=$pr_url"
  echo "latest=$latest"
  echo "exit=$final_status"

  if [[ -f "$latest_tmp" ]]; then
    commit_terminal_evidence
    record_finalize_failure "publish terminal run evidence"
    discard_preflight_stage || true
    quarantine_current_latest || true
    if ! render_latest_evidence; then
      discard_latest_stage || true
      record_finalize_failure "render terminal failure evidence"
    fi
    if [[ -f "$latest_tmp" ]]; then
      commit_terminal_evidence
      record_finalize_failure "publish terminal failure evidence"
    fi
  else
    record_finalize_failure "missing staged latest evidence"
  fi
  quarantine_current_latest || true
  discard_preflight_stage || true
  discard_latest_stage || true
  discard_terminal_ledger_stage || true
  exit "$final_status"
}

main() {
  local arg=""
  local run_stamp=""
  local script_source="${BASH_SOURCE[0]}"
  local script_parent=""
  local resolved_runtime=""
  local runtime_parent=""
  local stable_preflight_path=""
  local claimed_preflight_path=""
  local workflow_status=0

  requested_backend="${ORCA_BACKEND:-}"
  if [[ -n "$requested_backend" && "$requested_backend" != codex ]]; then
    echo "unsupported proving backend: ${requested_backend}; expected codex" >&2
    return 64
  fi
  export ORCA_BACKEND=codex
  for arg in "$@"; do
    case "$arg" in
      --preflight-only) mode=preflight ;;
      --complexity=simple) complexity=simple ;;
      --complexity=medium) complexity=medium ;;
      --complexity=challenging) complexity=challenging ;;
      *) echo "unsupported argument: $arg" >&2; return 64 ;;
    esac
  done
  case "$complexity" in
    simple) launcher_deadline_ms=600000 ;;
    medium) launcher_deadline_ms=1800000 ;;
    challenging) launcher_deadline_ms=2700000 ;;
  esac

  controller_capture_before_deadline started_at_ms now_ms || return $?
  if [[ ! "$started_at_ms" =~ ^[0-9]+$ ]]; then
    return 64
  fi
  launcher_absolute_deadline_at_ms=$(( started_at_ms + launcher_deadline_ms ))
  launcher_work_deadline_at_ms=$((
    launcher_absolute_deadline_at_ms - launcher_finalization_reserve_ms
  ))
  launcher_deadline_at_ms="$launcher_work_deadline_at_ms"

  script_parent="${script_source%/*}"
  if [[ "$script_parent" == "$script_source" ]]; then
    script_parent=.
  fi
  script_dir=$(cd "$script_parent" && pwd -P) || return $?
  controller_capture_before_deadline source_root \
    git -C "$script_dir/../.." rev-parse --show-toplevel || return $?
  controller_capture_before_deadline git_common_dir \
    git -C "$source_root" rev-parse --git-common-dir || return $?
  if [[ "$git_common_dir" != /* ]]; then
    git_common_dir="$source_root/$git_common_dir"
  fi
  primary_root=$(cd "$git_common_dir/.." && pwd -P) || return $?
  capture_before_deadline run_stamp date -u +%Y%m%d%H%M%S || return $?

  run_id="$run_stamp-$$"
  branch="orca/improve-$run_id"
  worktree="${TMPDIR:-/tmp}/orcats-improvement-$run_id"
  run_dir="$source_root/.orca/improvement-loop/runs/$run_id"
  latest="$source_root/.orca/improvement-loop/latest.json"
  latest_quarantine="${latest}.superseded.$run_id"
  launcher_log="$run_dir/launcher.log"
  ledger="$source_root/.orca/improvement-loop/issues.jsonl"
  ledger_lock="${ledger}.lock"
  preflight_path="$source_root/.orca/improvement-loop/preflight.json"
  preflight_quarantine="${preflight_path}.superseded.$run_id"
  protected_package_lock="$primary_root/package-lock.json"
  launcher_finalization_ready=true

  run_before_deadline validate_issue_ledger "$ledger"
  capture_before_deadline ledger_base_snapshot mktemp \
    "${TMPDIR:-/tmp}/orcats-ledger-base.XXXXXX"
  run_before_deadline cp "$ledger" "$ledger_base_snapshot"
  quarantine_prior_evidence
  snapshot_package_lock
  capture_before_deadline artifact_digest compute_artifact_digest "$source_root"
  run_before_deadline mkdir -p "$run_dir"
  exec > "$launcher_log" 2>&1

  capture_delivery_identity
  phase=runtime-build
  capture_before_deadline runtime_head git -C "$source_root" rev-parse HEAD
  runtime_path="$run_dir/runtime/orcats"
  run_before_deadline build_runtime
  if [[ ! -x "$runtime_path" ]]; then
    echo "pinned Orcats binary is not executable: $runtime_path" >&2
    return 1
  fi
  runtime_parent="${runtime_path%/*}"
  resolved_runtime=$(PATH="$runtime_parent:$PATH" command -v orcats)
  if [[ "$resolved_runtime" != "$runtime_path" ]]; then
    echo "pinned Orcats binary did not resolve first: $resolved_runtime" >&2
    return 1
  fi
  capture_before_deadline runtime_sha256 sha256_file "$runtime_path"
  capture_before_deadline runtime_version "$runtime_path" --version
  echo "runtime_path=$runtime_path"
  echo "runtime_head=$runtime_head"
  echo "runtime_sha256=$runtime_sha256"
  echo "runtime_version=$runtime_version"
  phase=setup

  if [[ "$mode" == live ]]; then
    run_before_deadline assert_required_merge_protection
    stable_preflight_path="$preflight_path"
    claimed_preflight_path="$source_root/.orca/improvement-loop/preflight-claims/$run_id.json"
    claim_preflight_attestation "$stable_preflight_path" "$claimed_preflight_path"
    validate_claimed_preflight_attestation "$preflight_path"
  fi

  run_before_deadline git -C "$source_root" fetch origin main
  capture_before_deadline base_sha git -C "$source_root" rev-parse origin/main
  if [[ "$mode" == live ]]; then
    capture_before_deadline preflight_base_sha jq -er \
      '.baseSha' "$preflight_path"
    if [[ "$preflight_base_sha" != "$base_sha" ]]; then
      echo "preflight origin/main SHA does not match live origin/main" >&2
      return 66
    fi
  fi
  run_before_deadline git -C "$source_root" worktree add \
    "$worktree" -b "$branch" origin/main
  run_before_deadline copy_locked_artifacts
  run_before_deadline verify_locked_artifact_copy

  cd "$worktree"
  run_before_deadline bun install --frozen-lockfile

  if [[ "$mode" == preflight ]]; then
    phase=preflight
    set +e
    run_before_deadline run_preflight_gates
    preflight_worker_exit_code=$?
    set -e
    if [[ "$preflight_worker_exit_code" -ne 0 ]]; then
      return "$preflight_worker_exit_code"
    fi
    capture_before_deadline preflight_worker_completed_at_ms now_ms
    return 0
  fi

  phase=live
  set +e
  run_before_deadline run_live_workflow
  workflow_status=$?
  set -e
  return "$workflow_status"
}

trap finalize EXIT
trap 'launcher_signal_status=143; exit 143' TERM
trap 'launcher_signal_status=130; exit 130' INT
trap 'launcher_signal_status=129; exit 129' HUP
main "$@"
