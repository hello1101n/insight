{{- define "insight.syncResources.input" -}}
- name: sync_resources
  default: "{}"
{{- end -}}

{{- define "insight.syncResources.argument" -}}
- name: sync_resources
  value: {{ `"{{inputs.parameters.sync_resources}}"` }}
{{- end -}}
