{{- define "insight.admission.identityInputs" -}}
- name: admission_managed
  default: "false"
- name: admission_connector
  default: ""
- name: admission_source_id
  default: ""
{{- end }}

{{- define "insight.admission.forwardIdentity" -}}
- name: admission_managed
  value: "{{`{{inputs.parameters.admission_managed}}`}}"
- name: admission_connector
  value: "{{`{{inputs.parameters.admission_connector}}`}}"
- name: admission_source_id
  value: "{{`{{inputs.parameters.admission_source_id}}`}}"
{{- end }}

{{- define "insight.admission.tokenVolume" -}}
volumes:
  - name: stage-auth
    projected:
      sources:
        - serviceAccountToken:
            audience: insight-connectors
            expirationSeconds: 600
            path: token
{{- end }}

{{- define "insight.admission.tokenMount" -}}
volumeMounts:
  - name: stage-auth
    mountPath: /var/run/secrets/insight-connectors
    readOnly: true
{{- end }}

{{- define "insight.admission.clientEnv" -}}
- name: STAGE_ADMISSION_URL
  value: {{ printf "http://%s-connectors:8089" .Release.Name | quote }}
- name: SYNC_ID
  value: "{{`{{workflow.uid}}`}}"
- name: WORKFLOW_NAME
  value: "{{`{{workflow.name}}`}}"
- name: ADMISSION_CONNECTOR
  value: "{{`{{inputs.parameters.admission_connector}}`}}"
- name: ADMISSION_SOURCE_ID
  value: "{{`{{inputs.parameters.admission_source_id}}`}}"
{{- end }}

{{- define "insight.admission.task" -}}
- name: admit-{{ .stage }}
  {{- with .depends }}
  depends: {{ . | quote }}
  {{- end }}
  when: {{ printf "'{{inputs.parameters.admission_managed}}' == 'true'%s" (default "" .condition) | quote }}
  templateRef:
    name: stage-admission
    template: gate
  arguments:
    parameters:
      - name: stage
        value: {{ .stage | quote }}
      - name: admission_connector
        value: "{{`{{inputs.parameters.data_source}}`}}"
      - name: admission_source_id
        value: "{{`{{inputs.parameters.insight_source_id}}`}}"
{{- end }}

{{- define "insight.admission.workArgs" -}}
- name: admission_stage
  value: {{ printf "{{=inputs.parameters.admission_managed == 'true' ? '%s' : ''}}" . | quote }}
{{- $stage := . }}
{{- range list "cpu_millis" "memory_bytes" }}
- name: {{ . }}
  value: {{ printf "{{=inputs.parameters.admission_managed == 'true' ? tasks['admit-%s'].outputs.parameters.%s : ''}}" $stage . | quote }}
{{- end }}
{{- end }}

{{- define "insight.admission.workInputs" -}}
{{- range list "admission_stage" "cpu_millis" "memory_bytes" }}
- name: {{ . }}
  default: ""
{{- end }}
{{- end }}

{{- define "insight.admission.workMetadata" -}}
metadata:
  labels:
    insight.cyberfabric.com/stage: "{{`{{inputs.parameters.admission_stage}}`}}"
    insight.cyberfabric.com/attempt: "1"
podSpecPatch: >-
  {{`{{=inputs.parameters.cpu_millis == '' ? '{}' : toJson({'containers':[{'name':'main','resources':{'requests':{'cpu':inputs.parameters.cpu_millis+'m','memory':inputs.parameters.memory_bytes},'limits':{'cpu':inputs.parameters.cpu_millis+'m','memory':inputs.parameters.memory_bytes} } } ]})}}`}}
{{- end }}

{{- define "insight.admission.dbtEnv" -}}
- name: ADMISSION_STAGE
  value: "{{`{{inputs.parameters.admission_stage}}`}}"
- name: SYNC_ID
  value: "{{`{{workflow.uid}}`}}"
- name: ADMISSION_ATTEMPT
  value: "1"
{{- end }}
