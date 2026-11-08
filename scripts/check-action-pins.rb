# frozen_string_literal: true

# Uses Ruby's bundled YAML parser; no packages or network access are needed.
require "yaml"

module ActionPins
  COMMIT = /\A[^\s@]+\/[^\s@]+@[0-9a-f]{40}\z/i
  DIGEST = /\A[^\s@]+@sha256:[0-9a-f]{64}\z/i

  def self.local?(value)
    value.is_a?(String) && value.start_with?("./") && value.length > 2 &&
      !value.match?(/\s|\$\{\{/) && !value.split("/").include?("..")
  end

  def self.action?(value)
    return false unless value.is_a?(String)
    return DIGEST.match?(value.delete_prefix("docker://")) if value.start_with?("docker://")

    local?(value) || COMMIT.match?(value)
  end

  def self.errors(source)
    document = YAML.safe_load(source, aliases: true)
    return ["expected a YAML mapping"] unless document.is_a?(Hash)

    errors = []
    check = lambda do |value, location, valid|
      errors << "#{location}: pin #{value.inspect} to a full commit SHA or image digest" unless valid
    end
    steps = lambda do |items, location|
      Array(items).each_with_index do |step, index|
        next unless step.is_a?(Hash) && step.key?("uses")

        check.call(step["uses"], "#{location}[#{index}].uses", action?(step["uses"]))
      end
    end
    image = lambda do |value, location|
      value = value["image"] if value.is_a?(Hash)
      check.call(value, location, value.is_a?(String) && DIGEST.match?(value))
    end

    (document["jobs"] || {}).each do |name, job|
      check.call(job["uses"], "jobs.#{name}.uses", action?(job["uses"])) if job.key?("uses")
      steps.call(job["steps"], "jobs.#{name}.steps")
      image.call(job["container"], "jobs.#{name}.container") if job.key?("container")
      (job["services"] || {}).each do |service, config|
        image.call(config, "jobs.#{name}.services.#{service}")
      end
    end
    runs = document["runs"] || {}
    steps.call(runs["steps"], "runs.steps") if runs["using"] == "composite"
    if runs["using"] == "docker"
      value = runs["image"]
      unless value == "Dockerfile" || local?(value)
        value = value.delete_prefix("docker://") if value.is_a?(String)
        image.call(value, "runs.image")
      end
    end
    errors
  rescue Psych::Exception, NoMethodError, TypeError => error
    ["invalid workflow/action YAML: #{error.message}"]
  end

  def self.files
    tracked = IO.popen(["git", "ls-files", "-z"], &:read).split("\0")
    raise "git ls-files failed" unless $?.success?

    tracked.select do |path|
      path.match?(%r{\A\.github/workflows/[^/]+\.ya?ml\z}) ||
        path.match?(%r{(?:\A|/)action\.ya?ml\z})
    end
  end
end

if $PROGRAM_NAME == __FILE__
  files = ActionPins.files
  abort "No workflow or action files found" if files.empty?
  errors = files.flat_map do |path|
    if File.symlink?(path)
      ["#{path}: workflow/action files must not be symlinks"]
    else
      ActionPins.errors(File.read(path)).map { |error| "#{path}: #{error}" }
    end
  end
  abort errors.join("\n") unless errors.empty?

  puts "Action pins verified in #{files.length} workflow/action files."
end
