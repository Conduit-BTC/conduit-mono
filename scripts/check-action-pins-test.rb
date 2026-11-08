# frozen_string_literal: true

require_relative "check-action-pins"
require "tmpdir"
require "fileutils"

sha = "a" * 40
digest = "b" * 64
accepted = [
  "jobs: {build: {steps: [{uses: 'actions/checkout@#{sha}'}]}}",
  "jobs: {build: {uses: 'org/repo/.github/workflows/build.yml@#{sha}'}}",
  "jobs: {build: {uses: './.github/workflows/build.yml'}}",
  "jobs: {build: {steps: [{uses: './.github/actions/build'}]}}",
  "jobs: {build: {steps: [{uses: 'docker://alpine@sha256:#{digest}'}]}}",
  "jobs: {build: {container: {image: 'alpine@sha256:#{digest}'}}}",
  "jobs: {build: {services: {db: {image: 'postgres:17@sha256:#{digest}'}}}}",
  "runs: {using: composite, steps: [{uses: 'org/repo/subdir@#{sha}'}]}",
  "runs: {using: docker, image: Dockerfile}",
  "runs: {using: docker, image: 'docker://alpine@sha256:#{digest}'}",
  "jobs:\n  a:\n    steps:\n      - &checkout\n        uses: actions/checkout@#{sha}\n      - *checkout\n",
  "jobs:\n  a:\n    steps:\n      - uses: >-\n          actions/checkout@#{sha}\n",
  "jobs: {build: {steps: [{run: 'echo uses: example/action@v1'}]}}"
]
rejected = [
  "jobs: {build: {steps: [{uses: 'actions/checkout@v4'}]}}",
  "jobs: {build: {steps: [{uses: 'actions/checkout@main'}]}}",
  "jobs: {build: {steps: [{uses: 'actions/checkout@abcdef0'}]}}",
  "jobs: {build: {steps: [{uses: 'actions/checkout@${{ inputs.ref }}'}]}}",
  "jobs: {build: {steps: [{uses: null}]}}",
  "jobs: {build: {uses: 'org/repo/.github/workflows/build.yml@v1'}}",
  "jobs: {build: {steps: [{uses: 'docker://alpine:latest'}]}}",
  "jobs: {build: {container: 'alpine:latest'}}",
  "jobs: {build: {services: {db: {image: 'postgres:17'}}}}",
  "runs: {using: composite, steps: [{uses: 'org/repo@v1'}]}",
  "runs: {using: docker, image: 'docker://alpine:latest'}",
  "jobs:\n  a:\n    steps:\n      - &checkout\n        uses: actions/checkout@v4\n      - *checkout\n",
  "jobs:\n  a:\n    steps:\n      - uses: >-\n          actions/checkout@v4\n",
  "jobs: {build: {steps: [{uses: './../outside'}]}}",
  "jobs: ["
]
accepted.each do |source|
  errors = ActionPins.errors(source)
  abort "Expected acceptance: #{source}\n#{errors.join("\n")}" unless errors.empty?
end
rejected.each do |source|
  abort "Expected rejection: #{source}" if ActionPins.errors(source).empty?
end

# Exercise discovery in a real index: newly created files must be checked before
# staging, while ignored dependency/build directories must stay excluded.
Dir.mktmpdir("action-pins") do |directory|
  Dir.chdir(directory) do
    system("git", "init", "-q", exception: true)
    FileUtils.mkdir_p([".github/workflows", "local-action", "ignored"])
    File.write(".gitignore", "ignored/\n")
    File.write(".github/workflows/ci.yml", accepted.first)
    system("git", "add", ".github/workflows/ci.yml", exception: true)
    File.write(".github/workflows/new.yaml", rejected.first)
    File.write("local-action/action.yml", rejected[9])
    File.write("ignored/action.yml", rejected[9])
    files = ActionPins.files
    expected = [".github/workflows/ci.yml", ".github/workflows/new.yaml", "local-action/action.yml"]
    abort "Incorrect file discovery: #{files.inspect}" unless files.sort == expected.sort
    invalid = files.select { |path| !ActionPins.errors(File.read(path)).empty? }
    abort "Untracked mutable dependencies escaped detection" unless invalid.sort == expected.drop(1).sort
  end
end
puts "Action pin regression checks passed (#{accepted.length} accepted, #{rejected.length} rejected)."
puts "Tracked, untracked and ignored file discovery checks passed."
