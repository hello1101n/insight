{{- define "insight.syncResources.input" -}}
- name: sync_resources
  default: "{}"
{{- end -}}

{{- define "insight.syncResources.argument" -}}
- name: sync_resources
  value: {{ `"{{inputs.parameters.sync_resources}}"` }}
{{- end -}}

{{- define "insight.syncResources.podPatch" -}}
{{- $cap := "nil" -}}
{{- if eq . "dbt" -}}
  {{- $cap = "r.dbt_query_memory_bytes" -}}
{{- end -}}
{{- $patch := `
{{=
  let r = sprig.fromJson(inputs.parameters.sync_resources);
  let cpu = r.%s_cpu_millis;
  let memory = r.%s_memory_bytes;
  let cap = %s;
  let sizes = sprig.merge(
    cpu == nil ? {} : {'cpu': string(int(cpu)) + 'm'},
    memory == nil ? {} : {'memory': string(int(memory))});
  let main = sprig.merge(
    {'name': 'main'},
    len(sizes) == 0 ? {} : {'resources': {'requests': sizes, 'limits': sizes} },
    cap == nil ? {} : {'env': [{'name': 'DBT_QUERY_MEMORY_BYTES', 'value': string(int(cap))}]});
  toJson(len(main) == 1 ? {} : {'containers': [main]})
}}
` -}}
{{- printf $patch . . $cap | replace "\n" " " | trim -}}
{{- end -}}
