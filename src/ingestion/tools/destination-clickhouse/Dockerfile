# syntax=docker/dockerfile:1
FROM airbyte/destination-clickhouse:2.1.29@sha256:5f750b529654dce94e8820769b9439bb953a88b9234f424cf24cf88d51247038 AS destination
FROM eclipse-temurin:21-jdk AS build
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends patch && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:e06f38c29c725cee96016f065b200a10bf2541c24bb604c4b3ec809114724406 https://raw.githubusercontent.com/airbytehq/airbyte/6a90a4f297c774a06bcc0290a7036797a3933fdd/airbyte-integrations/connectors/destination-clickhouse/src/main/kotlin/io/airbyte/integrations/destination/clickhouse/config/ClickhouseBeanFactory.kt ClickhouseBeanFactory.kt
ADD --checksum=sha256:c6e9e2636889828e19c8811d5ab890862538c89dc2a3101956dfee3c2a8ba6b1 https://github.com/JetBrains/kotlin/releases/download/v2.1.10/kotlin-compiler-2.1.10.zip compiler.zip
COPY --from=destination /airbyte/lib/ lib/
COPY attempt.patch .
RUN jar xf compiler.zip && patch ClickhouseBeanFactory.kt attempt.patch && \
    classpath=$(find /build/lib -name '*.jar' | paste -sd ':' -) && \
    java -cp kotlinc/lib/kotlin-compiler.jar org.jetbrains.kotlin.cli.jvm.K2JVMCompiler \
      -no-stdlib -no-reflect -jvm-target 17 -classpath "$classpath" -d classes ClickhouseBeanFactory.kt && \
    jar uf lib/io.airbyte.airbyte-integrations.connectors-destination-clickhouse.jar -C classes io
FROM destination
COPY --from=build /build/lib/io.airbyte.airbyte-integrations.connectors-destination-clickhouse.jar /airbyte/lib/
COPY --chmod=755 entrypoint.py /airbyte/insight-entrypoint
ENV AIRBYTE_ENTRYPOINT=/airbyte/insight-entrypoint
ENTRYPOINT ["/airbyte/insight-entrypoint"]
