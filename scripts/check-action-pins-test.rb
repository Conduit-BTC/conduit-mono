# frozen_string_literal: true

require_relative "check-action-pins"

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
puts "Action pin regression checks passed (#{accepted.length} accepted, #{rejected.length} rejected)."
