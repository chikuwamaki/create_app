# 緊急停止・復旧手順 / Emergency Stop Recovery

## 日本語版

### 概要
- 予算アラートや自動停止後の復旧手順。
- 停止対象: CloudFront無効化 / API LambdaのReserved concurrencyを0。

### 即時停止（手動・詳細）

#### A) CloudFrontを停止（サイト停止）
1. AWSコンソールで「CloudFront」を開く。
2. 左メニュー「Distributions」を開く。
3. 対象のDistributionを選択（Site URLのドメイン名と一致するもの）。
4. 「Disable」をクリック。
5. Statusが「Deployed」になり、Disabledになるのを待つ。

#### B) API Lambdaを停止
1. AWSコンソールで「Lambda」を開く。
2. 関数「ShiftSubmissionHandler」を選択。
3. 「Configuration」タブを開く。
4. 「Concurrency」を開く。
5. 「Reserved concurrency」を0に設定して保存。

#### C) 停止確認
- Site URLが表示できない/エラーになる。
- APIがエラーになる。

### 復旧（手動）

#### 1) CloudFrontを有効化
1. CloudFront -> Distributions -> 対象を選択。
2. 「Enable」をクリック。
3. Statusが「Deployed」になるまで待つ。

#### 2) Lambdaの制限を解除
1. Lambda -> ShiftSubmissionHandler。
2. Configuration -> Concurrency。
3. Reserved concurrencyを「未予約」に戻す。

### 復旧チェックリスト
- [ ] CloudFrontがEnabledでDeployed。
- [ ] Lambda concurrencyが未予約。
- [ ] サイト表示が正常。
- [ ] Cognitoログインが正常。
- [ ] API GET /availabilityが成功。
- [ ] シフト作成・確認が表示できる。
- [ ] CloudWatchのエラー増加がない。

### 監視項目
- AWS Budgets: 月額しきい値と通知配信。
- CloudFront: 4xx/5xx、リクエスト数。
- API Gateway: 4xx/5xx、レイテンシ。
- Lambda: errors, throttles, duration。
- DynamoDB: throttled, consumed capacity。
- Cognito: Hosted UI errors, sign-in failures。

### 画面キャプチャ用プレースホルダー
- CloudFront 一覧: ![CloudFront Distributions](screenshots/cloudfront-distributions.png)
- CloudFront Disable: ![Disable CloudFront](screenshots/cloudfront-disable.png)
- Lambda 一覧: ![Lambda Functions](screenshots/lambda-functions.png)
- Lambda Concurrency: ![Lambda Concurrency](screenshots/lambda-concurrency.png)
- CloudFront Enabled: ![CloudFront Enabled](screenshots/cloudfront-enabled.png)
- Lambda Concurrency Cleared: ![Lambda Concurrency Cleared](screenshots/lambda-concurrency-cleared.png)

### 注意点
- Budgetsは数時間の遅延あり。
- 復旧後もエラーが出る場合はCloudFront状態とLambda concurrencyを再確認。

## English Version

### Overview
- Recovery steps after budget auto-shutdown.
- Stop targets: CloudFront disabled / API Lambda reserved concurrency set to 0.

### Immediate stop (manual, detailed)

#### A) Disable CloudFront (stop the website)
1. Open AWS Console -> CloudFront.
2. Click "Distributions".
3. Select the distribution matching the site URL domain.
4. Click "Disable".
5. Wait until Status is "Deployed" and the state is Disabled.

#### B) Stop the API Lambda
1. Open AWS Console -> Lambda.
2. Select "ShiftSubmissionHandler".
3. Open "Configuration".
4. Open "Concurrency".
5. Set "Reserved concurrency" to 0 and save.

#### C) Verify stop
- Site URL fails to load or shows an error.
- API calls return errors.

### Restore (manual)

#### 1) Re-enable CloudFront
1. CloudFront -> Distributions -> select the target.
2. Click "Enable".
3. Wait for Status to be "Deployed".

#### 2) Remove Lambda concurrency limit
1. Lambda -> ShiftSubmissionHandler.
2. Configuration -> Concurrency.
3. Remove reserved concurrency (set to unreserved).

### Recovery checklist
- [ ] CloudFront is Enabled and Deployed.
- [ ] Lambda concurrency is unreserved.
- [ ] Site loads correctly.
- [ ] Cognito login works.
- [ ] API GET /availability succeeds.
- [ ] Shift create/list pages load.
- [ ] CloudWatch errors are not increasing.

### Monitoring items
- AWS Budgets: monthly threshold and delivery.
- CloudFront: 4xx/5xx error rate and requests.
- API Gateway: 4xx/5xx and latency.
- Lambda: errors, throttles, duration.
- DynamoDB: throttling and capacity spikes.
- Cognito: Hosted UI errors and sign-in failures.

### Screenshot placeholders
- CloudFront list: ![CloudFront Distributions](screenshots/cloudfront-distributions.png)
- Disable dialog: ![Disable CloudFront](screenshots/cloudfront-disable.png)
- Lambda list: ![Lambda Functions](screenshots/lambda-functions.png)
- Lambda concurrency: ![Lambda Concurrency](screenshots/lambda-concurrency.png)
- CloudFront enabled: ![CloudFront Enabled](screenshots/cloudfront-enabled.png)
- Lambda cleared: ![Lambda Concurrency Cleared](screenshots/lambda-concurrency-cleared.png)

### Notes
- Budgets notifications can be delayed by hours.
- If errors persist, re-check CloudFront status and Lambda concurrency.
